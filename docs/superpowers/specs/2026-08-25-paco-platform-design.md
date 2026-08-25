# Paco platform design: from sealed agent to extensible platform

**Date:** 2026-08-25
**Status:** Approved in brainstorming; awaiting implementation planning
**Prior spec:** [2026-08-03-self-hosted-paco-design.md](2026-08-03-self-hosted-paco-design.md)

## Context

Paco today is a finished self-hosted product wrapped around a sealed agent.
The shell — installer, sandbox topology, approval gate, durable turns, auth,
orgs, previews — is strong and stays. The seal is the ceiling:

- `buildArgs` always emits `--setting-sources ""` and `--strict-mcp-config`,
  and never emits `--mcp-config`. MCP is structurally unreachable
  (`packages/claude-code/options.ts`).
- The subagent roster is a frozen two-entry constant
  (`DEFAULT_AGENTS`: explorer, executor).
- Nothing learned in one chat reaches the next. `customInstructions` has one
  hardcoded caller.
- Claude Code is the only agent backend; a Claude subscription is a hard
  dependency.
- The browser is the only entry point; nothing runs unless a user opens a
  chat.

This design unseals the agent without losing the shell's simplicity. It draws
on four studied systems:

- **deepseek-harness (dsh):** append-only session event log with the
  invariant *model-visible means logged*; capability seams
  (definition / provider / consumer); plugin discoverability via a GitHub
  topic.
- **Eve (eve.dev):** filesystem-slot configuration (the directory a file
  lands in determines how it loads); channels as edge adapters (normalize,
  address→session mapping, delivery); turn policy (`steer`/`queue`);
  first-class `evals/`.
- **EverOS:** markdown-native memory, indexed; ingest → extract → index →
  recall; episodes (user) vs skills (agent) as separate tracks; offline
  reflection.
- **OpenFX:** the in-house Zig agent (TUI, ACP server, MCP client, skills,
  subagents, permissions engine) — the second backend that proves the seam.

## Decisions taken (with the user, 2026-08-25)

1. **Backend-agnostic.** The agent runs behind an interface; Claude Code and
   OpenFX are peer implementations.
2. **Third-party plugin ecosystem**, not operator-only extension.
3. **Sandboxed plugin runtime** — browser-extension trust model, not
   dsh-style in-process loading.
4. **UI designer as a full design mode** — propose → pick → annotate → hand
   off, not merely a roster entry.
5. **Memory at all four scopes** — project, user, org, and gated agent-skill
   evolution.
6. **Task board + chat** orchestration — not chat-only, not an unattended
   fleet.
7. **Architecture C:** event-log spine + sandboxed extension host. The
   existing Next.js/Drizzle core stays; the append-only session event log is
   the only way subsystems know about each other; a typed capability API is
   the only way extensions act.

## Goals

- Most functionality with the simplest management story: the operator's world
  grows by exactly three settings pages (Plugins, Agents, Memory) and one
  surface (Tasks). The installer does not change.
- Every extension — first-party or community — is a directory of slots behind
  a consent screen. One mental model.
- Chat remains the front door. New surfaces are places work lands, not
  things a user must learn.

## Non-goals

- No Cordis-style kernel rewrite. Paco's core is not a plugin tree.
- No Python sidecar for memory. The EverOS pattern is reimplemented
  in-process; the one-command install stays intact.
- No unattended-fleet autonomy. Every autonomous path terminates in the
  existing approval flow.
- No vector database in v1 of memory. Keyword/recency retrieval first;
  vectors only if retrieval proves insufficient.

---

## Section 1: The spine — session event log + agent backend seam

One subsystem, not two: the log's vocabulary is the interface's vocabulary.

### 1a. Session event log

A new append-only table `session_events`:

- `id` (monotonic per chat), `chatId`, `type`, `payload` (jsonb),
  `createdAt`.
- Event types: `turn/start`, `turn/end`, `step/start`, `step/end`,
  `user/message`, `assistant/chunk`, `assistant/message`, `tool/call`,
  `tool/result`, `approval/requested`, `approval/decided`,
  `steer/buffered`, `usage/reported`.

**Invariant (enforced):** anything that reaches a model request must be
reconstructable from the log. A runtime assertion in the turn driver
compares the derived history with what is sent; divergence is a bug.

`chatMessages` becomes a projection of the log — kept for query speed,
derived never authored. Fork, replay, resume, telemetry, memory ingest, task
board, and plugin hooks all read this one stream.

### 1b. `AgentBackend` interface

New package `packages/agent-backend` owns the interface; `packages/claude-code` becomes its first implementation.

```ts
interface AgentBackend {
  capabilities(): BackendCapabilities;   // mcp, forking, effort, subagents…
  startTurn(ctx: TurnContext): TurnHandle;
}
interface TurnHandle {
  events: AsyncIterable<SessionEvent>;   // the backend's only output channel
  steer(message: UserMessage): Promise<void>;
  interrupt(): Promise<void>;
}
```

- A backend's job is to emit well-formed session events. The UI stream,
  persistence, and usage accounting all derive from them in one pass, as
  `run-step.ts` does today.
- `capabilities()` lets the UI adapt instead of assume: a backend without
  subagent tiering hides the tier controls; one without MCP hides MCP
  grants. This is what makes OpenFX landable without breaking anything.
- The approval flow stays backend-agnostic: `approval/requested` /
  `approval/decided` are events; `decideApproval` and the policy engine are
  reused unchanged.

### 1c. Turn steering

Per-chat `turnPolicy: "steer" | "queue"`, default `steer`. A message
arriving mid-turn is durably appended (`steer/buffered`), then the backend's
`steer()` is invoked; a backend that cannot steer falls back to queue. For
Claude Code this maps to interrupt + resume with the buffered message.

### Testing

- **Conformance suite** in `packages/agent-backend`: any implementation must
  pass it (turn lifecycle ordering, steering semantics, event well-
  formedness, approval round-trip). This is the definition of done for
  Section 7.
- **Replay-equivalence test** in CI: project `chatMessages` from
  `session_events`, diff against the live table.

### Operator impact

None. No new settings, no new service, no installer change.

---

## Section 2: The plugin system

**Model:** a plugin is a directory of Eve-style slots; its code runs
sandboxed; everything it can do it does through a typed capability API; the
operator grants capabilities at install.

### Anatomy

```text
paco-plugin-example/
├── plugin.json     name, version, requested capabilities, Paco API range
├── tools/          each file → a model-facing tool
├── channels/       entry points (webhook → message/task)
├── skills/         SKILL.md packs (existing loader reused)
├── agents/         roster entries
├── renderers/      UI cards for this plugin's tool calls
└── hooks/          event-log subscribers
```

The slot a file lands in determines how it loads. No registration code.

### Execution and trust

- Plugin code runs in an isolated worker in a separate process with no
  ambient credentials, speaking a versioned RPC to Paco: the **capability
  API**.
- Capabilities: `events:subscribe`, `messages:post`, `tools:register`,
  `net:fetch(domains)`, `storage:kv`, `ui:panel`. The DB, filesystem, and
  tokens are not in the API and therefore not reachable.
- Install shows the requested capability list; grants are per-plugin,
  revocable in settings.
- **Renderers** are the one exception to the worker model: UI runs in the
  browser, so renderers ship as sandboxed iframes fed by props.
- MCP servers arrive through this system: a plugin manifest may declare MCP
  servers, which are emitted as `--mcp-config` for backends that support
  them — behind the same consent screen, keeping `--strict-mcp-config`
  reproducibility.

### Distribution

- Open discovery via a `paco-plugin` GitHub topic; install by repo name.
- Content-hash pinning in a lockfile, exactly as `skills-lock.json` does
  today.
- A curated "verified" shelf in the UI later; same mechanism.

### Error handling

A crashing or hanging plugin worker is isolated: its RPC calls time out,
its subscriptions are dropped, the chat continues. Plugin failures surface
as non-blocking notices, never as turn failures.

### Operator impact

One new settings page: **Plugins** (install, grants, enable/disable,
update).

---

## Section 3: Orchestration — roster, task board, evals

### Roster

- `DEFAULT_AGENTS` moves to an org-scoped `agents` table with a settings
  editor: name, description, prompt, model tier, tool allowlist, effort,
  per-agent plugin/MCP grants.
- Ships with four defaults: `explorer`, `executor`, `reviewer` (verifies
  executor output before it reaches the user), `designer` (Section 5).
- Roster entries are also a plugin slot.

### Task board

- New surface beside Sessions. A task = goal + status + assigned agent +
  executing chat, projected from the event log plus a `tasks` table.
- Tasks are born three ways: a user writes one; a **planner** agent
  decomposes a goal into a task tree, each task spawning its own worktree
  chat; a channel or schedule fires (Section 6).
- Approvals surface per-task using the existing approval cards. Humans
  watch, unblock, review.
- Chat remains the front door; a user who never opens the board loses
  nothing that exists today.

### Evals

- `evals/` directory per session repo plus a settings runner: scenario
  prompts with assertions, run on demand against any roster configuration.
- Purpose: make the editable roster manageable — change a prompt, run
  evals, see whether it regressed.

### Testing

Planner decomposition and task lifecycle are workflow steps and get the
same durable-step tests as chat turns. Evals are themselves the test
surface for roster changes.

### Operator impact

One new settings page (**Agents**) and one new surface (**Tasks**).

---

## Section 4: Memory

Markdown as source of truth, indexed for keyword/recency retrieval.
EverOS's pattern, in-process, no sidecar.

| Scope | Location | Written by | Consent surface |
|---|---|---|---|
| Project | `.paco/memory/*.md` in the session repo | Haiku-tier distillation on `turn/end` | Git-versioned, visible in diffs, editable as files |
| User | Paco data dir, per user | Distillation of stable preferences | **Memory settings page**: read, edit, delete every entry |
| Org | Paco data dir, org-scoped | Explicit promotion only ("save this for the team") — never automatic | Admin-editable page; promotion is the consent act |
| Skill evolution | Proposals on the task board | Scheduled reflection job clustering trajectories from the event log | A human merges or rejects every proposal |

**Retrieval:** relevant sections join `buildAppendSystemPrompt` via its
existing extension point. Selection is keyword + recency in v1.

**Error handling:** memory is additive context; a failed distillation or
retrieval never blocks a turn.

### Operator impact

One new settings page: **Memory**.

---

## Section 5: Design mode

A full loop, not a roster entry:

1. A chat toggle enters design mode; the `designer` agent (MCP-equipped —
   e.g. the daisyUI Blueprint server — briefed with a design-system summary
   distilled from the repo) produces **2–3 candidate screens as real
   running code on throwaway branches**.
2. The preview pane splits side-by-side. Candidates are real worktrees with
   real published ports — N previews instead of one, which the existing
   layout supports natively.
3. The user picks and annotates by **clicking elements in the preview**: a
   lightweight inspector script injected into preview frames maps clicks to
   selector + source location, so "more spacing here" arrives anchored.
4. Iteration stays visual until approval. The winning candidate merges to
   the chat's real branch; losing branches are deleted; the **executor**
   takes over with the design as its spec.

**Why candidates are code, not mockups:** reuses worktrees, previews, and
diffs as they exist; users judge real responsive behavior; hand-off is a
`git merge`, not a translation step that can drift.

**Depends on:** Section 2 (MCP), Section 3 (roster).

---

## Section 6: Channels + scheduling — as plugins

Thin by design; Section 2 did the work.

- A channel is a plugin using `channels/` + `messages:post` +
  `events:subscribe`, doing Eve's three jobs: normalize inbound into a user
  message; own the address→session mapping; decide delivery of replies.
- **Slack ships first-party as the proving plugin**: mention the bot, a
  task appears on the board; results reply threaded.
- Schedules are `schedules/` slot entries: cron + prompt + repo + agent,
  firing tasks onto the board. "Run the suite nightly, open a fix PR if
  red" becomes a config row.
- Everything inherits the approval flow; an unattended agent can do nothing
  the policy engine gates.

---

## Section 7: OpenFX as the second backend

- `packages/openfx-backend` implements `AgentBackend` over OpenFX's ACP
  server, mapping ACP sessions and permission requests to session events
  and the existing approval flow.
- `capabilities()` reports honestly; the UI adapts. Where OpenFX lacks
  Claude Code's subagent tiering, orchestration (which owns the roster)
  fans out through Paco instead.
- Model settings grow a per-backend section: OpenFX is BYO
  endpoint/key, local inference included.
- **Definition of done: passing the Section 1 conformance suite.**

This section is the proof the seam is real and the exit from single-vendor
dependency.

---

## Build order

```text
1 spine  ──►  2 plugins ──►  6 channels/scheduling
   │             │
   │             └─►  5 design mode (needs MCP)
   ├─►  3 orchestration (board needs the log; roster feeds 5)
   ├─►  4 memory (ingests the log)
   └─►  7 openfx (implements the interface)
```

Sections 3, 4, and 7 can proceed in parallel once 1 lands; 5 needs 2 and 3.
Section 1 is the only piece that is expensive to get wrong; everything
after it is additive.

## Risks

- **Spine migration:** `chatMessages` as projection must be
  bit-equivalent before anything depends on the log. Mitigation: the
  replay-equivalence CI test lands with the table, before any consumer.
- **Plugin API stability:** third parties build on it; version it from day
  one (`plugin.json` declares a Paco API range) and treat breaking changes
  like dsh does not — with deprecation windows.
- **OpenFX maturity:** it is experimental. The capability-declaration
  design contains this — an honest, narrow capability set is acceptable;
  the conformance suite is the bar.
- **Memory quality:** bad distillation poisons future turns. Mitigations:
  everything inspectable and editable; org memory promotion-only; skill
  evolution human-gated.
- **Reflection/planner token cost:** distillation runs on the cheapest
  tier; reflection is scheduled, not per-turn; both are visible in the
  existing usage accounting.
