# Section 3: Orchestration Implementation Plan — Roster, Task Board, Planner, Evals

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the hardcoded two-agent roster into an org-scoped, user-editable database roster with four defaults; add a durable task board where a planner decomposes goals into worktree-backed tasks, a reviewer gates executor output, and evals answer "did my roster change make the agent worse?"

**Architecture:** Roster rows (validated `ClaudeAgentDefinition`s) replace `DEFAULT_AGENTS` at chat-environment assembly. Tasks are rows projected alongside the session event log; each running task owns a chat (= worktree = branch) in its session; the planner is a structured-output headless turn; the reviewer is an automatic follow-up turn whose verdict moves the task. Evals discover `evals/*.json` scenarios in the session repo and run them in disposable chats.

**Tech Stack:** TypeScript, Drizzle/Postgres, Bun tests, Zod v4, Next.js App Router + daisyUI skill, Claude Code structured output (`jsonSchema` in ClaudeCodeOptions).

**Spec:** `docs/superpowers/specs/2026-08-25-paco-platform-design.md` (Section 3)

## Global Constraints

- Section 1 plan's Global Constraints apply verbatim (pnpm/bun/no-any/extensions/aliases/migrations/`pnpm fix`/no per-task `pnpm run ci`/no Co-Authored-By).
- Zero-customer ruling: breaking changes fine, no compat shims. Nothing deferred: every task lands complete.
- Roster safety invariant: a roster row is validated with the zod schema BEFORE it ever reaches `--agents`; an invalid row is excluded with a console.error, never passed through, never fatal to the turn.
- Task state machine (binding, single source of truth `TASK_STATUSES`): `todo → running → review → done`, with `blocked` reachable from running (approval pending), `failed` reachable from running/review, `review → running` on reviewer rejection (bounded: max 2 automatic reviewer rejections per task, then `blocked` for a human). No other transitions.
- All new UI reads `.agents/skills/daisyui/SKILL.md` first and matches sibling pages.

---

### Task 1: Roster table + validated helpers + seed

**Files:**
- Modify: `apps/web/lib/db/schema.ts` — `rosterAgents` table
- Create: migration (ONLY this table)
- Create: `apps/web/lib/db/roster.ts`
- Create: `apps/web/lib/agent/agent-definition-schema.ts` (zod mirror of `ClaudeAgentDefinition` from `@paco/claude-code` — every field: description, prompt, model?, tools?, disallowedTools?, effort?, maxTurns?)
- Test: `apps/web/lib/db/roster.test.ts` (mocked-db pattern from session-events.test.ts), `apps/web/lib/agent/agent-definition-schema.test.ts`

**Interfaces:**

```ts
export const rosterAgents = pgTable("roster_agents", {
  id: text("id").primaryKey(),                          // nanoid
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),                          // ^[a-z][a-z0-9-]{0,31}$ — becomes the --agents key
  definition: jsonb("definition").notNull(),             // ClaudeAgentDefinition, zod-validated on write AND read
  builtin: boolean("builtin").notNull().default(false),  // seeded defaults; editable but not deletable
  enabled: boolean("enabled").notNull().default(true),
  createdAt/updatedAt: timestamp
}, (t) => [uniqueIndex("roster_agents_org_name_idx").on(t.organizationId, t.name)]);

// roster.ts
export async function getRoster(organizationId: string): Promise<Record<string, ClaudeAgentDefinition>>; // enabled + valid rows only; invalid → console.error + skip
export async function upsertRosterAgent(organizationId: string, name: string, definition: unknown): Promise<{ok:true} | {ok:false; error:string}>; // zod-validate first
export async function deleteRosterAgent(organizationId: string, name: string): Promise<{ok:boolean; error?:string}>; // builtin rows refuse deletion
export async function setRosterAgentEnabled(organizationId, name, enabled): Promise<void>;
export async function seedDefaultRoster(organizationId: string): Promise<void>; // idempotent: inserts missing builtin rows only
export const DEFAULT_ROSTER: Record<string, ClaudeAgentDefinition>; // explorer+executor (copy EXACTLY from packages/claude-code DEFAULT_AGENTS) + reviewer + designer (definitions below)
```

Reviewer default: `{ description: "Verifies completed implementation work against what was asked before it reaches the user: correctness, scope fidelity, and test evidence.", prompt: "You are a reviewer agent. You are given what was requested and what was done. Verify the work: read the changed files, run the stated tests if cheap, and check that exactly what was asked was delivered — no more, no less. Report PASS or FAIL with a concise list of specific problems and file:line references. Do not fix anything yourself.", model: "sonnet", tools: ["Read", "Grep", "Glob", "Bash"] }`.
Designer default: `{ description: "UI and visual design work: layouts, components, styling, design-system-consistent screens.", prompt: "You are a designer agent. Read the project's design skills (look for .agents/skills/ and any SKILL.md files the environment lists) before writing any markup. Produce polished, design-system-consistent UI. Prefer editing real components over mockups. State the design decisions you made and why.", model: "sonnet" }`.

**Steps (TDD):** schema-mirror tests first (valid def round-trips; unknown fields rejected — `.strict()`; bad effort enum rejected) → roster helper tests (invalid jsonb row skipped+logged; builtin delete refused; seed idempotence — run twice, no dupes; org isolation) → schema+migration → implement → seed wired into org creation (find where organizations are created — grep `insert(organizations)` — and call seedDefaultRoster there; also lazily in getRoster when org has zero rows, so existing dev instances work) → commit: `Move the agent roster into an org-scoped table with seeded defaults`

---

### Task 2: Chats use the DB roster

**Files:**
- Modify: `apps/web/lib/agent/chat-environment.ts` (or wherever `agents`/DEFAULT_AGENTS flow into AgentCallOptions — trace `resolveAgents` in run-step.ts backwards; today `options.agents ?? DEFAULT_AGENTS`)
- Modify: `apps/web/app/workflows/chat.ts` if the options are assembled there
- Test: extend the touched module's existing tests

**Semantics:** the turn's `agents` = `{...pluginAgentContributions-if-Section-2-landed, ...getRoster(orgId)}` — DB roster wins collisions; if Section 2's contributions module does not exist yet on this branch, wire ONLY the roster and leave a one-line `// plugin agent contributions merge here (Section 2 Task 8)` marker. `DEFAULT_AGENTS` in packages/claude-code STAYS (it is the package-level fallback and the seed source) but the web app no longer passes undefined agents — it always resolves the roster explicitly.

**Steps (TDD):** failing test (chat options carry roster agents from a mocked getRoster; disabled agent absent; DB wins over plugin contribution when both defined) → implement → commit: `Resolve chat subagents from the org roster`

---

### Task 3: Agents settings page

**Files:**
- Create: `apps/web/app/settings/agents/page.tsx`, `agent-editor-dialog.tsx`, `agent-row.tsx`, `actions.ts`, `loading.tsx`
- Modify: `apps/web/app/settings/layout.tsx` (nav entry "Agents")
- Test: `apps/web/app/settings/agents/agent-editor-dialog.test.tsx` + `actions.test.ts`

**Requirements:** admin-gated like other admin settings (reuse the same guard helper Task 9 of Section 2 uses — find it once, reuse). List roster rows: name, description, model tier badge, effort, enabled toggle, builtin marker; edit dialog fields: name (locked for builtin), description, prompt (textarea), model (reuse the EXISTING model-selection component if one is reusable — read `apps/web/components/model-combobox.tsx` first), effort select, tools allowlist (multiselect over the known tool names: Read, Grep, Glob, Bash, Edit, Write, WebFetch, WebSearch, Task, TodoWrite — plus free-text add), maxTurns number. Create flows through `upsertRosterAgent`; server actions validate and return field errors inline. daisyUI skill first; match sibling settings pages.

**Steps (TDD):** actions tests (admin gate; validation errors returned not thrown; builtin delete refused surfaces error) → dialog component test (fields render from definition; save calls action with edited values) → implement → commit: `Add the Agents settings page`

---

### Task 4: `tasks` table + state machine

**Files:**
- Modify: `apps/web/lib/db/schema.ts` — `tasks` table
- Create: migration (ONLY this)
- Create: `apps/web/lib/tasks/state.ts` (pure state machine), `apps/web/lib/db/tasks.ts` (helpers)
- Test: `apps/web/lib/tasks/state.test.ts`, `apps/web/lib/db/tasks.test.ts`

**Interfaces:**

```ts
export const TASK_STATUSES = ["todo", "running", "blocked", "review", "done", "failed"] as const;
export const tasks = pgTable("tasks", {
  id: text("id").primaryKey(),
  organizationId: text FK cascade,
  sessionId: text FK cascade,                     // the session whose repo the task works in
  chatId: text nullable FK "set null",            // the chat executing it (created when started)
  parentTaskId: text nullable (self-reference),   // planner trees
  title: text notNull,
  goal: text notNull,                             // the full prompt/goal text
  status: text enum TASK_STATUSES notNull default "todo",
  assignedAgent: text nullable,                   // roster name; null = orchestrator default
  reviewerRejections: integer notNull default 0,
  origin: text enum ["user","planner","schedule","channel"] notNull default "user",
  resultSummary: text nullable,
  createdBy: text nullable FK users "set null",
  createdAt/updatedAt
}, indexes: (organizationId,status), (sessionId), (parentTaskId));

// state.ts — PURE:
export function canTransition(from: TaskStatus, to: TaskStatus): boolean; // exactly the Global Constraints machine
export function nextOnReviewerVerdict(current: {status: TaskStatus; reviewerRejections: number}, verdict: "pass"|"fail"):
  { status: TaskStatus; reviewerRejections: number }; // review+pass→done; review+fail→running (rejections+1) unless rejections>=2 → blocked
// tasks.ts — helpers that ENFORCE canTransition (throw TaskTransitionError on violation), typed CRUD, listTasks(orgId, {status?, sessionId?}), taskTree(rootId)
```

**Steps (TDD):** exhaustive state.test (every legal edge true, a table of illegal edges false; reviewer-verdict bounds incl. the 2-rejection cap) → db helper tests (transition enforcement throws; tree assembly) → implement → commit: `Add the tasks table and state machine`

---

### Task 5: Start-a-task pipeline

**Files:**
- Create: `apps/web/lib/tasks/start.ts`
- Test: `apps/web/lib/tasks/start.test.ts`

**Interfaces:**

```ts
export async function startTask(taskId: string, opts?: { maxTurns?: number }): Promise<{ok:true; chatId: string} | {ok:false; error:string}>;
```

Semantics: read the task (must be `todo`); create a chat in the task's session EXACTLY the way the UI's new-chat path does (trace what `apps/web/app/api/chat` or the session UI calls to create a chat + worktree — reuse that function, do not duplicate worktree logic); transition todo→running with the chatId; kick the chat workflow with `prompt = buildTaskPrompt(task)` where `buildTaskPrompt` (exported, tested) renders: the goal, the parent-task context line when parentTaskId is set (parent title + goal), and — when task.assignedAgent is set — a line instructing the orchestrator to delegate the work to that subagent by name. On workflow-start failure: transition back running→failed with `resultSummary` = the error.

**Steps (TDD):** buildTaskPrompt snapshot-style tests (all three variants) → startTask tests (todo gate; chat created via the reused path — mocked; failure path → failed) → implement → commit: `Add the task start pipeline`

---

### Task 6: Task completion + reviewer gate in the workflow

**Files:**
- Modify: `apps/web/app/workflows/chat-post-finish.ts` (read it + its tests FIRST — it is the post-turn hook point)
- Create: `apps/web/lib/tasks/reviewer-gate.ts`
- Test: extend `chat-post-finish.test.ts`, create `reviewer-gate.test.ts`

**Semantics:** after a turn finishes in a chat that belongs to a `running` task (lookup by chatId):
- turn errored (isError) → task → `failed`, resultSummary = finish reason.
- turn clean → `runReviewerGate(task, chat)`:

```ts
// reviewer-gate.ts
export async function runReviewerGate(task: TaskRow, chatId: string): Promise<"pass" | "fail" | "skipped">;
```

If the org roster has no enabled `reviewer` → return "skipped" (task → review→… no: task goes running→review→done via pass? With no reviewer, transition running→review→done immediately — the review state is still recorded for the audit trail). Otherwise run ONE headless turn (reuse `runAgentTurn` with the chat's worktree cwd and `jsonSchema: {type:"object",properties:{verdict:{enum:["pass","fail"]},problems:{type:"array",items:{type:"string"}}},required:["verdict"]}`, `maxTurns: 15`, systemPrompt framing from the reviewer roster prompt + the task goal + `git diff` summary of the chat branch) — parse the structured output; malformed → treat as "fail" with problems=["reviewer output malformed"]. Apply `nextOnReviewerVerdict`; on fail-with-retries-left, kick ONE more executor turn on the same chat with prompt = the problems list ("The reviewer rejected this work for these reasons — fix them: …"), which on finish re-enters this same gate (the rejection counter bounds the loop at 2). resultSummary on done = first 500 chars of the reviewer's summary or the turn's last text.

**Steps (TDD):** reviewer-gate tests (no reviewer → skipped+done; pass→done; fail→rejections+1 + re-kick mocked; 3rd fail→blocked; malformed output→fail path) → post-finish wiring tests (non-task chat untouched; task chat routes through gate) → implement → commit: `Gate task completion behind the reviewer agent`

---

### Task 7: Planner decomposition

**Files:**
- Create: `apps/web/lib/tasks/planner.ts`
- Test: `apps/web/lib/tasks/planner.test.ts`

**Interfaces:**

```ts
export async function planGoal(params: { organizationId: string; sessionId: string; goal: string; createdBy?: string }): Promise<{ok:true; rootTaskId: string; taskIds: string[]} | {ok:false; error:string}>;
```

Semantics: one headless structured-output turn (`runAgentTurn` against the SESSION repo directory (read-only exploration; `tools: ["Read","Grep","Glob","Bash"]` via a planner agent definition assembled inline — NOT a roster row), `jsonSchema: {type:"object",properties:{tasks:{type:"array",maxItems:12,items:{type:"object",properties:{title:{type:"string"},goal:{type:"string"},assignedAgent:{type:["string","null"]}},required:["title","goal"]}}},required:["tasks"]}`, prompt = the goal + "decompose into 2-12 independent, individually-completable tasks; each goal must be self-contained (the executor sees only its own goal text); name an assignedAgent from: <enabled roster names> or null"). Create a root task (title = the goal truncated 80 chars, status stays `todo`, it is a grouping node — root tasks with children are never started directly; enforce in startTask: a task with children → {ok:false}) + child rows origin "planner". Zero/malformed tasks from the model → {ok:false} with the parse error; nothing persisted.

**Steps (TDD):** tests with runAgentTurn mocked (happy tree persisted with parent links; malformed JSON → nothing persisted; assignedAgent not in roster → nulled with warn; >12 tasks → truncated to 12 with warn) → also add the root-with-children guard test to start.test.ts → implement (export `buildPlannerPrompt` for tests) → commit: `Add planner decomposition into task trees`

---

### Task 8: Task board UI + actions

**Files:**
- Create: `apps/web/app/tasks/page.tsx`, `task-board.tsx`, `task-card.tsx`, `new-task-dialog.tsx`, `actions.ts`, `loading.tsx`, `layout.tsx` (minimal, matches app chrome — read how `/sessions` frames itself)
- Modify: the app's top-level nav (find where Sessions is linked — session-drawer/app chrome — add Tasks beside it)
- Test: `apps/web/app/tasks/actions.test.ts`, `task-board.test.tsx`

**Requirements:** Board = six status columns (or a grouped list if sibling patterns favor it — match the app's visual language, daisyUI skill first) showing org tasks: title, session name, assigned agent badge, origin badge, rejections count when >0, link to the executing chat (`/sessions/<sessionId>/chats/<chatId>` — verify the real route shape from the sessions pages). Actions: `createTaskAction` (title, goal, sessionId picker from the user's sessions, optional assignedAgent from enabled roster, optional "plan this goal" toggle → planGoal instead of direct create), `startTaskAction` (todo only), `retryTaskAction` (failed→todo... state machine has no failed→todo edge — ADD `failed → todo` and `blocked → running` (human unblock) to the state machine in Task 4 NOW so it ships there; this plan line is the reminder that they exist for the UI), `unblockTaskAction` (blocked→running: resets reviewerRejections to 0 and re-kicks the executor fix turn). Auth: any org member (not admin-only — tasks are collaborative); scope every query by the caller's org.

**Steps (TDD):** actions tests (org scoping — another org's task invisible/untouchable; state-gate errors surfaced; plan toggle routes to planner) → board component test (columns render fixture tasks; start button only on todo leaves) → implement → commit: `Add the task board`

---

### Task 9: Evals — discovery, runner, results

**Files:**
- Create: `apps/web/lib/evals/discovery.ts`, `apps/web/lib/evals/runner.ts`
- Modify: `apps/web/lib/db/schema.ts` — `evalRuns` table: id, organizationId, sessionId, scenarioName, status enum ["running","passed","failed","error"], details jsonb (assertion results), rosterSnapshot jsonb (the roster used), startedAt/finishedAt. Migration (ONLY this).
- Create: `apps/web/app/sessions/[sessionId]/evals/page.tsx` + `actions.ts` (colocated with the session UI — evals belong to a session repo; read the session layout first; quote the [sessionId] path in git commands)
- Test: `discovery.test.ts`, `runner.test.ts`, `actions.test.ts`

**Interfaces:**

```ts
// evals/discovery.ts — scenario files: <sessionRepo>/evals/*.json
export const evalScenarioSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),                       // what to ask the agent
  assertions: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: "file-exists", path: z.string() }),
    z.object({ kind: "file-contains", path: z.string(), needle: z.string() }),
    z.object({ kind: "command-succeeds", command: z.string() }),   // run in the eval worktree, 60s timeout
    z.object({ kind: "transcript-matches", pattern: z.string() }), // regex over the turn's text output
  ])).min(1),
  maxTurns: z.number().int().positive().max(50).default(25),
});
export async function discoverEvalScenarios(sessionRepoDir: string): Promise<{scenarios: EvalScenario[]; errors: string[]}>;
// evals/runner.ts
export async function runEvalScenario(params: { organizationId; sessionId; scenario: EvalScenario }): Promise<EvalRunRow>;
```

Runner semantics: create a THROWAWAY chat/worktree in the session (same reused creation path as startTask), run one turn with the scenario prompt and the CURRENT org roster, evaluate every assertion (all must pass; command-succeeds runs via the sandbox exec so it executes in the container — read packages/sandbox interface exec), persist the evalRuns row with per-assertion detail, then DELETE the throwaway chat/worktree (find the existing chat-deletion/archive path and reuse; if none exists for full deletion, archive per the archived-workspaces convention and note it). Failure of the harness itself (turn error, worktree failure) → status "error" with the message, never a crash.

Session evals page: list discovered scenarios (+ discovery errors inline), Run button per scenario and Run-all, history table of evalRuns (status, when, per-assertion badges, roster snapshot expandable). Org-member auth.

**Steps (TDD):** discovery tests (valid/invalid/missing dir); runner tests with turn+sandbox mocked (all-pass → passed; one assertion fails → failed with detail naming it; harness error → error; throwaway cleaned in finally) → page actions tests → implement → commit: `Add repo-defined eval scenarios with a session runner`

---

### Task 10: Task events into the session log

**Files:**
- Modify: `packages/agent-backend/events.ts` — extend `sessionEventSchema` with: `{type:"task/created", taskId, title, origin}`, `{type:"task/status", taskId, from, to}`, `{type:"eval/finished", evalRunId, scenarioName, status}` (task events carry no turnId — they are chat-adjacent, appended to the task's chat when one exists, else skipped).
- Modify: `apps/web/lib/db/tasks.ts` + `apps/web/lib/evals/runner.ts` — append these events at the corresponding mutations (appendSessionEvents; chatId nullable → skip when null).
- Test: extend events.test.ts (new variants parse) + tasks.test.ts (status change appends event when chat attached).

**Steps (TDD)** → commit: `Record task and eval lifecycle in the session event log`

---

## Final verification
- [ ] `pnpm run ci` at repo root.
- [ ] Manual smoke: seed roster appears in settings; create a task, start it, watch it run→review→done with the reviewer; plan a goal into a tree; run an eval scenario end-to-end.
