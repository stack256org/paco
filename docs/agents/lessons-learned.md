# Lessons learned

Things that cost real time to find. Each one is here because it was not
guessable from the code, and because the failure was quiet — a wrong result
that looked like a right one, or nothing happening at all.

Add to this when you learn something the hard way.

## The failure modes that look like success

**A 2xx with no body is not "nothing happened".** The chat resume endpoint
answered "nothing is streaming" with `204 No Content`. The client's transport
resumes inside `while (!gotFinish)` and guards with
`if (!res.ok || !res.body) throw` — but 204 is 2xx, and Chrome hands back an
empty `ReadableStream` rather than `null`. Zero chunks is not an error, so it
re-fetched immediately, forever: ~50 requests a second per open tab. The
endpoint now returns a stream carrying a single bare `finish` chunk.

**A module-level cache does not survive a Turbopack rebuild.** Both the Drizzle
pool and pg-boss were memoized in module scope, so every edit in development
opened another pool while the previous one kept its connections. Postgres
eventually refused new clients and every page returned "Failed to get session".
Anything process-wide belongs on `globalThis`.

**Pointing at the wrong git directory succeeds.** The session repository is a
real repository on the default branch, so a file listing, a `git status`, or a
diff against it returns an empty-but-valid answer. Chat-scoped work must go
through `resolveWorkCwd`.

**Git never looks inside a nested repository — and reports that silence as
clean.** A session used as a workspace has projects cloned *into* it, each
with its own `.git`. `git status`/`git diff` at the worktree root shows one
opaque `?? project/` row (or nothing, when the directory is gitignored) and
none of the changes within, so every surface that ran a single git command at
the root — the Changes tab, the Source Control panel, the status counts, the
unsaved-work probe deciding whether a workspace is disposable — under-reported
or reported clean. Any code asking git about a worktree must go through
`lib/git/nested-repos.ts`: discover the nested roots, run the command per
repository, prefix the paths. Staging the `?? project/` row is worse than
noise: it records a gitlink, which silently replaces the project's files in
any clone of the parent. And the parent is not the only repository with that
row — a repo cloned inside a repo gives the *intermediate* one its own
`inner/` trap, so the filter runs per repository (`rootsWithin`), not just at
the root. Both of those, plus `git add` dying on a staged rename's source
path (`fatal: pathspec … did not match any files` — the source exists neither
on disk nor in the index, so staging must send the new name only), were found
by the exhaustive scenario sweep (`pnpm --dir apps/web sweep:multi-repo`),
not by the hand-picked tests. When a change fans out across layouts × states
× operations, enumerate the product space and run all of it once.

**A predicate that finds nothing can mean "everything".**
`sendAutomaticallyWhen` located a step boundary by searching for a `step-start`
part, which Claude Code never emits. With no boundary it scanned the whole
message, saw long-finished tool calls, and re-submitted the prompt after every
turn — one message ended up with 45 copies of the same answer.

## Claude Code CLI

- **`--bare` is unusable here.** It disables OAuth and keychain reads and
  requires `ANTHROPIC_API_KEY`. Subscription auth needs the explicit isolation
  flags instead: `--setting-sources ""`, `--strict-mcp-config`,
  `--disable-slash-commands`.
- **`--session-id` must be a UUID.** Message ids are nanoids; mint a UUID.
- **A session belongs to a directory.** Change a chat's working directory and
  its stored session id stops resolving — the CLI exits immediately having
  written nothing, which reaches the user as an empty turn with zero tokens.
  Retry once without `--resume`.
- **`PreToolUse` hooks fire even under `bypassPermissions`.** That is what makes
  per-call approval possible. `manual` mode does *not* gate in headless runs; it
  simply executes.
- **Pass extra settings inline with `--settings`.** Writing
  `.claude/settings.json` into the workspace would put Paco's configuration in
  the user's diff, and would be overridden by `--setting-sources ""` anyway.

## git worktrees

- **git 2.39 does not support relative worktree pointers.** It reports such a
  worktree as *prunable*, and the next `git worktree prune` deletes the link.
  `--relative-paths` arrived in 2.48.
- **`git worktree add -b` needs a commit to branch from.** A freshly `git
  init`ed repository has no ref, so create an empty initial commit first.
- **git refuses to commit without an identity.** A sandbox with no configured
  `gitUser` cannot commit at all, so there is always a default.

## Sandbox and processes

- **SIGTERM to a parent does not reap its children.** `gh` shells out to `git`,
  and `close` waits for every writer to release stdout — so a timed-out call
  hung for as long as the grandchild lived. Spawn detached, signal the process
  group, and settle the promise on timeout regardless.
- **Bundlers break `import.meta.url`.** Anything that needs a real path on disk
  at runtime — a hook script, an executable — must be written out from an
  embedded string, not imported.

## Postgres

- **`jsonb` cannot hold a NUL byte** (SQLSTATE 22P05). Turbopack's binary cache
  files contain them, which is why an unignored `.next/` broke message
  persistence outright.
- **Untracked files are why diffs explode.** A scaffolded Next.js app with no
  `.gitignore` produced a 650,000-line diff whose serialisation exhausted the
  heap. Every workspace gets a baseline `.gitignore`.

## Build

- **`NEXT_PUBLIC_*` is inlined by Turbopack at build time, including in server
  code, not just the browser bundle.** This is why `NEXT_PUBLIC_APP_URL` had to
  become `APP_URL`: a published Docker image would otherwise have frozen every
  installation to whichever origin CI happened to build with, silently, since
  nothing errors. Verified empirically in this repo: with the old prefix,
  `process.env.NEXT_PUBLIC_APP_URL` appeared zero times in
  `apps/web/.next/server`, because Turbopack had already replaced every
  reference with the literal value before emitting the chunk. To prove a
  rename like this actually took, grep `.next/server` for the *value*
  (`grep -rl "$VALUE" apps/web/.next/server --include="*.js"`), not the old
  variable name — the name simply disappears either way. Any setting that must
  differ per deployment cannot carry the `NEXT_PUBLIC_` prefix.

- **A literal hit in that same `.next/server` grep is not automatically proof
  of inlining — check that the value actually varies.** After the rename,
  grepping for `localhost:3066` (the dev `.env`'s `APP_URL`) still found seven
  hits. All seven turned out to be the same three hardcoded example strings in
  `lib/config/required-env.ts` and `lib/app-url.ts` (e.g. "for example
  `http://localhost:3066`" in a validation error message) — not the configured
  value being baked in; the code underneath still read `process.env.APP_URL`
  live. Confirmed by rebuilding with a canary value
  (`http://zzz-task9-canary-host:19999`): it appeared nowhere in
  `.next/server`, while `localhost:3066` still did, unchanged. When a
  grep-for-value check comes back non-zero, swap in a value that could not
  possibly be a coincidence before concluding the check failed.

- **`Encountered unexpected file in NFT list` is expected here, and benign.**
  `workspaceRoot()` builds a path from `os.homedir()`, which Turbopack's file
  tracer cannot resolve, so it conservatively pulls `next.config.ts` into the
  trace for every route that reaches `workspace-paths.ts`. The trace list is
  only consumed by `output: "standalone"`, which this app does not use. Do not
  "fix" it by making the workspace root a literal — it genuinely depends on the
  host.

## Verifying in a browser

- **A CDP screenshot is not what the user sees.** The old git drawer captured as
  a white block on a dark page. It was absolutely positioned with a transform
  transition, so it composited on its own layer, and the capture flattened that
  layer against the host's `prefers-color-scheme: light` rather than the page.
  (That drawer is gone — it is now the Changes tab of the workspace pane — but
  the lesson holds for anything on its own compositing layer.)
  `getComputedStyle` reported near-black throughout, before and after a
  deliberate background change. Trust the computed style over the pixels, and
  do not "fix" a layer the engine says is already correct.

## Containerising Paco

- **Next's standalone output is unusable here.** The same dynamic
  `path.join(os.homedir(), …)` that makes the file tracer warn also leaves its
  traced `node_modules` effectively empty, so the migration step could not
  resolve `drizzle-orm`. The image copies the built workspace instead — larger,
  but it starts.
- **A path relative to the working directory is a trap in a container.**
  `MIGRATIONS_FOLDER` was `"./lib/db/migrations"`, which worked only because
  `pnpm build` runs from `apps/web`. Invoked from the repository root it failed
  with "Can't find meta/_journal.json", which reads like missing files rather
  than a wrong starting point. Resolve from `import.meta.dirname`.
- **pnpm 11 refuses to install while any `allowBuilds` entry is undecided.**
  Three were left as the literal string `set this to true or false`, which no
  interactive install surfaces but every image build hits.
- **On macOS, `pgrep -f "docker.*build"` is not a valid wait condition.** It
  matches Docker Desktop's long-lived `com.docker.build` helper process (alive
  for hours, unrelated to any specific build in progress) and it also matches
  the polling shell's own command line, which contains the very pattern it is
  searching for. Wait on the specific build's PID instead, then check for the
  resulting image explicitly — a vanished process is not proof the build
  succeeded.

## TypeScript

- **Method parameters are compared bivariantly.** A structural type declaring
  `cwd?: string` accepts an implementation requiring `cwd: string`, so calls that
  omit it type-check and fail at runtime. Mirror the real signature exactly.
