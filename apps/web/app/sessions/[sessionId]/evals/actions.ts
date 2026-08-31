"use server";

import { repoDir } from "@paco/sandbox";
import { hostWorkspaceFor } from "@/lib/agent/workspace-paths";
import { listEvalRuns } from "@/lib/db/eval-runs";
import type { EvalRun } from "@/lib/db/schema";
import { getSessionById, type SessionRecord } from "@/lib/db/sessions";
import { SESSION_NOT_FOUND } from "@/lib/error-copy";
import {
  discoverEvalScenarios,
  evalScenarioSchema,
  type EvalScenario,
} from "@/lib/evals/discovery";
import { runEvalScenario } from "@/lib/evals/runner";
import { getOrganization } from "@/lib/org/organization";

/** Looks up the session every action here runs against. */
async function requireEvalSession(
  sessionId: string,
): Promise<{ organizationId: string; session: SessionRecord }> {
  const session = await getSessionById(sessionId);
  if (!session) {
    throw new Error(SESSION_NOT_FOUND);
  }

  const organization = await getOrganization();

  return { organizationId: organization.id, session };
}

/** Where a session's repo lives on the host, or `undefined` before it exists. */
function sessionRepoDirFor(session: SessionRecord): string | undefined {
  if (!session.sandboxState) {
    return;
  }
  try {
    return repoDir(hostWorkspaceFor(session.sandboxState));
  } catch {
    // A session that has no repo materialized yet has nothing to discover.
  }
}

export type { EvalScenario };
export type { EvalRun };

/** Discovered scenarios for this session, plus any files that failed to parse. */
export async function listEvalScenariosAction(
  sessionId: string,
): Promise<{ scenarios: EvalScenario[]; errors: string[] }> {
  const { session } = await requireEvalSession(sessionId);
  const sessionRepoDir = sessionRepoDirFor(session);
  if (!sessionRepoDir) {
    return { scenarios: [], errors: [] };
  }
  return await discoverEvalScenarios(sessionRepoDir);
}

/** This session's eval run history, newest first. */
export async function listEvalHistoryAction(
  sessionId: string,
): Promise<EvalRun[]> {
  const { organizationId } = await requireEvalSession(sessionId);
  return await listEvalRuns(organizationId, sessionId);
}

/**
 * Runs one scenario and returns its finished row.
 *
 * The scenario is re-validated here rather than trusted as sent — the
 * client only ever got it from `listEvalScenariosAction` in the first
 * place, but a request body is not that guarantee, the same reasoning
 * `saveRosterAgent` re-validates a roster definition it also just handed
 * out.
 */
export async function runEvalScenarioAction(
  sessionId: string,
  scenario: EvalScenario,
): Promise<EvalRun> {
  const { organizationId } = await requireEvalSession(sessionId);
  const parsed = evalScenarioSchema.parse(scenario);
  return await runEvalScenario({
    organizationId,
    sessionId,
    scenario: parsed,
  });
}

/** Runs every given scenario, one after another, returning each finished row. */
export async function runAllEvalScenariosAction(
  sessionId: string,
  scenarios: EvalScenario[],
): Promise<EvalRun[]> {
  const { organizationId } = await requireEvalSession(sessionId);
  const results: EvalRun[] = [];
  for (const scenario of scenarios) {
    const parsed = evalScenarioSchema.parse(scenario);
    // Sequential by design: throwaway chats share the session's worktree
    // machinery, and evals are a diagnostic tool, not a throughput path —
    // running scenarios one at a time keeps their sandbox/chat usage
    // predictable rather than bursting several at once.
    results.push(
      await runEvalScenario({ organizationId, sessionId, scenario: parsed }),
    );
  }
  return results;
}
