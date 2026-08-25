"use server";

import { repoDir } from "@paco/sandbox";
import { hostWorkspaceFor } from "@/lib/agent/workspace-paths";
import { listEvalRuns } from "@/lib/db/eval-runs";
import type { EvalRun } from "@/lib/db/schema";
import { getSessionById, type SessionRecord } from "@/lib/db/sessions";
import { NOT_YOURS, SIGNED_OUT } from "@/lib/error-copy";
import {
  discoverEvalScenarios,
  evalScenarioSchema,
  type EvalScenario,
} from "@/lib/evals/discovery";
import { runEvalScenario } from "@/lib/evals/runner";
import { getMemberRole } from "@/lib/org/membership";
import { getOrganization } from "@/lib/org/organization";
import { getServerSession } from "@/lib/session/get-server-session";

/**
 * Auth gate every action in this file re-checks, the same as `requireAdmin`
 * does for the admin-only actions elsewhere: session ownership (the same
 * check every `/sessions/[sessionId]` page makes) plus organisation
 * membership, since evals write `evalRuns` rows scoped to the organisation,
 * not just the session's owner.
 */
async function requireEvalAccess(
  sessionId: string,
): Promise<{ organizationId: string; session: SessionRecord }> {
  const authSession = await getServerSession();
  if (!authSession?.user?.id) {
    throw new Error(SIGNED_OUT);
  }

  const session = await getSessionById(sessionId);
  if (!session || session.userId !== authSession.user.id) {
    throw new Error(NOT_YOURS);
  }

  const role = await getMemberRole(authSession.user.id);
  if (!role) {
    throw new Error(NOT_YOURS);
  }

  const organization = await getOrganization();
  if (!organization) {
    throw new Error("There is no organisation yet.");
  }

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
  const { session } = await requireEvalAccess(sessionId);
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
  const { organizationId } = await requireEvalAccess(sessionId);
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
  const { organizationId } = await requireEvalAccess(sessionId);
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
  const { organizationId } = await requireEvalAccess(sessionId);
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
