# Architecture

Paco is a Turborepo monorepo. It drives the **Claude Code CLI** headlessly
against a **Docker sandbox**, one per session, entirely on the operator's own
machine.

## Core flow

```text
Browser  ->  Next.js + durable workflow  ->  Claude Code (host)  ->  Docker sandbox
```

1. **Web** (`apps/web`) owns authentication, sessions, chats, and the UI, and
   runs the durable workflow that drives a turn.
2. **`@paco/claude-code`** spawns the CLI, speaks its streaming JSON protocol,
   and maps it to AI SDK UI chunks. There is no agent loop here — Claude Code
   owns the loop, the tools, and its own context management.
3. **`@paco/sandbox`** is the execution environment: a Docker container per
   session, plus the git worktree layout and skill discovery.

## Where the agent runs, and why it matters

The CLI runs **on the host**, not in the container. Its working directory is a
chat's worktree, which is mounted into the container. So:

- The agent edits files on the host; the container *runs* them.
- A dev server has to be started inside the container to be reachable through
  the published ports — the system prompt says so, because the agent cannot
  infer it.
- The agent has the operator's privileges, which is why tool calls are gated
  (below).

## Workspace layout

A session is one git repository. A chat is one worktree of it.

```text
~/.paco/workspaces/session_<id>/     mounted at /workspace *and* at this path
  repo/                              the clone, or `git init`, on its default branch
  chats/<chatId>/                    a worktree, on branch chat/<chatId>
```

Two details are load-bearing:

- **The repository sits under `repo/`, not at the root.** A worktree's `.git` is
  a *file* pointing back into `repo/.git/worktrees/<id>`, so the repository and
  its worktrees have to be siblings under one mount.
- **The workspace is mounted twice, at the same source.** Git records an
  absolute path in the two files that join a worktree to its repository. The
  agent runs on the host while worktrees are created in the container, so that
  one path has to be true on both sides. Relative pointers are not an option:
  git 2.39 reports a relative-pointer worktree as prunable, and the next
  `git worktree prune` deletes the link.

Anything chat-scoped resolves its directory through `resolveWorkCwd`, which
returns the chat's worktree — or the repository, for session-wide callers. One
function on purpose: pointed at the repository by mistake, a file listing or a
`git status` succeeds and simply shows nothing.

## Tool approval

The CLI runs with `--permission-mode bypassPermissions`, because every other
mode breaks the product: `acceptEdits` gates Bash, so the agent can write an app
and then not be allowed to start it, and `dontAsk` denies Bash outright.

The gate is Paco's instead. A `PreToolUse` hook — installed through `--settings`
as inline JSON, so a cloned repository's own `.claude/settings.json` still
cannot inject anything — fires before every tool call and blocks the CLI until
Paco answers. `decideApproval` decides: reads, in-worktree writes, and ordinary
development commands proceed; destructive or out-of-tree actions raise a prompt
in the chat and wait for the user.

`Bash` is decided the same way `Write` is, rather than by pattern-matching the
command string. The line is tokenized and split on control operators, and every
write target is resolved against the worktree; anything the parse cannot
statically understand asks. The command head must be on a short allowlist, and
heads that take another program as an argument (`sh`, `python3`, `xargs`,
`sudo`, `npx`, …) always ask, because half-checking one of those is precisely
how the previous regex denylist failed.

### What this does not stop

The agent may write a file inside its worktree without asking and then run it —
`node script.js`, `./scripts/x.sh` and `pnpm build` are all allowed, because
that is the product. So a deliberately hostile agent can still reach the host
in two steps, including overwriting the hook itself at
`~/.paco/hooks/pre-tool-use.mjs`; the hook is verified once per turn, not once
per step, and a turn is up to 500 steps.

Nothing inside this process closes that, and it is worth being plain about why:
the agent runs as the same OS user as Paco, so any protection Paco applies to
its own files is protection the agent can remove. The real boundary is
OS-level — a separate user, or running the CLI itself inside the container
rather than on the host. What the current design buys is that the escape is no
longer one unremarkable `Bash` call, and that both steps appear in the
transcript.

## GitHub

Through the `gh` CLI, with a per-user token stored encrypted. No GitHub App, no
installations, no webhook — a webhook cannot reach a self-hosted install on
localhost, so pull request and CI status are polled instead.

## Packages

```text
apps/web                Next.js app, durable workflows, auth, chat UI
packages/claude-code    CLI transport: options, process, protocol, UI stream,
                        approval policy and hook
packages/sandbox        Sandbox interface, Docker implementation, worktree
                        layout, git helpers, skill discovery
packages/shared         Shared utilities
packages/tsconfig       Shared TypeScript configs
```

## Subagents

The CLI's `--agents` flag supplies a roster Paco defines:

- **explorer** — read-only research (Read, Grep, Glob, Bash), on a cheap model
- **executor** — well-scoped implementation work

Tiering is where most of the token volume goes: an Opus-class model orchestrates
while Sonnet and Haiku subagents do the mechanical work.
