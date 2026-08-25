import type { SessionEvent } from "@paco/agent-backend";
import type { EvalRunStatus, TaskOrigin, TaskStatus } from "@/lib/db/schema";

/**
 * Compile-time drift guards between this app's task/eval enums and the
 * copies `packages/agent-backend/events.ts` keeps of them.
 *
 * That package cannot import from this app (it has no dependency on
 * apps/web), so its `taskStatusSchema` / `taskOriginSchema` /
 * `evalRunFinishedStatusSchema` duplicate `TASK_STATUSES` / `TASK_ORIGINS`
 * / `EvalRunStatus` (`lib/db/schema.ts`) by hand. Left alone, a status
 * added to one side and not the other would fail silently at runtime: the
 * database would accept a task in the new status while
 * `sessionEventSchema.parse` rejected the `task/status` event recording it
 * (or vice versa).
 *
 * This file makes that drift a typecheck failure instead. Each `Equals<>`
 * check is exact-union equality, so it fails whichever direction the lists
 * diverge: a member added only here, or only in the package. There is a
 * mirror-image comment on `packages/agent-backend/events.ts` pointing back
 * at this file, so a reader who lands on either side finds the other half.
 *
 * This file is never imported for its runtime value (it has none — every
 * declaration here is type-only) — it exists purely so `tsc`'s
 * project-wide typecheck (`apps/web`'s `tsconfig.json` `include`s every
 * `.ts` file, not just ones reachable from an entrypoint) walks it and
 * fails the build the moment the two sides disagree.
 */

type TaskStatusFromEvent = Extract<SessionEvent, { type: "task/status" }>["to"];
type TaskOriginFromEvent = Extract<
  SessionEvent,
  { type: "task/created" }
>["origin"];
type EvalFinishedStatusFromEvent = Extract<
  SessionEvent,
  { type: "eval/finished" }
>["status"];

/**
 * Exact union equality. `true` only when neither `A` nor `B` has a member
 * the other lacks — a strict superset/subset in either direction resolves
 * to `false`, and `AssertTrue` below turns that into a compile error.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Forces its argument to be the literal type `true` at the call site. */
type AssertTrue<T extends true> = T;

// TASK_STATUSES (this file's `TaskStatus`) <-> the `from`/`to` fields of
// `task/status` (packages/agent-backend/events.ts's `taskStatusSchema`).
export type _TaskStatusesMatchPackage = AssertTrue<
  Equals<TaskStatus, TaskStatusFromEvent>
>;

// TASK_ORIGINS (this file's `TaskOrigin`) <-> the `origin` field of
// `task/created` (packages/agent-backend/events.ts's `taskOriginSchema`).
export type _TaskOriginsMatchPackage = AssertTrue<
  Equals<TaskOrigin, TaskOriginFromEvent>
>;

// EvalRunStatus minus "running" (this file's `EvalRunStatus`, `"running"`
// is never a terminal status so it is never logged) <-> the `status` field
// of `eval/finished` (packages/agent-backend/events.ts's
// `evalRunFinishedStatusSchema`).
export type _EvalFinishedStatusesMatchPackage = AssertTrue<
  Equals<Exclude<EvalRunStatus, "running">, EvalFinishedStatusFromEvent>
>;
