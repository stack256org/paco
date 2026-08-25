import "server-only";

import type { ClaudeAgentDefinition } from "@paco/claude-code";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import { type EvalRun, evalRuns, type EvalRunStatus } from "@/lib/db/schema";

/** One assertion's outcome from a scenario run, see `lib/evals/runner.ts`. */
export interface EvalAssertionResult {
  kind:
    | "file-exists"
    | "file-contains"
    | "command-succeeds"
    | "transcript-matches";
  /** Human-readable label for the history table's per-assertion badges. */
  description: string;
  passed: boolean;
  /** Why it failed. Absent when `passed` is true. */
  message?: string;
}

/**
 * The shape `evalRuns.details` is expected to hold.
 *
 * The column itself is untyped JSONB (re-validated on read like
 * `rosterAgents.definition`), because nothing enforces this shape at the
 * database layer — this interface is the contract `runner.ts` writes and the
 * eval history UI reads.
 *
 * `assertions` is empty and `harnessError` is set when `status` is
 * `"error"`: the turn itself never produced anything to assert against, so
 * there is nothing to render as a per-assertion badge.
 */
export interface EvalRunDetails {
  assertions: EvalAssertionResult[];
  harnessError?: string;
}

/**
 * Starts an eval run: a `"running"` row recording the roster in effect right
 * now, before the throwaway turn kicks off.
 *
 * The roster is snapshotted here rather than after the turn completes so it
 * reflects what the turn actually ran against, not whatever the roster has
 * drifted to by the time the turn finishes (an admin could edit it mid-run).
 */
export async function startEvalRun(params: {
  organizationId: string;
  sessionId: string;
  scenarioName: string;
  rosterSnapshot: Record<string, ClaudeAgentDefinition>;
}): Promise<EvalRun> {
  const [row] = await db
    .insert(evalRuns)
    .values({
      id: nanoid(),
      organizationId: params.organizationId,
      sessionId: params.sessionId,
      scenarioName: params.scenarioName,
      status: "running",
      rosterSnapshot: params.rosterSnapshot,
    })
    .returning();

  if (!row) {
    throw new Error("Failed to create eval run");
  }
  return row;
}

/** Moves a `"running"` eval run to its terminal state, recording its result. */
export async function finishEvalRun(
  id: string,
  params: {
    status: Exclude<EvalRunStatus, "running">;
    details: EvalRunDetails;
  },
): Promise<EvalRun> {
  const [row] = await db
    .update(evalRuns)
    .set({
      status: params.status,
      details: params.details,
      finishedAt: new Date(),
    })
    .where(eq(evalRuns.id, id))
    .returning();

  if (!row) {
    throw new Error(`Eval run "${id}" not found`);
  }
  return row;
}

/** An organisation's eval history for one session, newest first. */
export async function listEvalRuns(
  organizationId: string,
  sessionId: string,
): Promise<EvalRun[]> {
  return await db
    .select()
    .from(evalRuns)
    .where(
      and(
        eq(evalRuns.organizationId, organizationId),
        eq(evalRuns.sessionId, sessionId),
      ),
    )
    .orderBy(desc(evalRuns.startedAt));
}
