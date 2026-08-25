"use server";

import { repoDir } from "@paco/sandbox";
import { isAdmin } from "@/lib/admin/require-admin";
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
 * Auth gate every action in this file re-checks: session ownership (the same
 * check every `/sessions/[sessionId]` page makes) plus a place in the
 * organisation, since evals write `evalRuns` rows scoped to the
 * organisation, not just the session's owner.
 *
 * "A place in the organisation" is a membership row OR `users.is_admin`, the
 * same OR `isAdmin` (`lib/admin/require-admin.ts`) applies everywhere else —
 * not a bare `getMemberRole` check. Requiring the row alone locked out the
 * exact population that file's docstring warns about: migration `0005`
 * promotes accounts by flag and makes only the oldest of them an org
 * `owner`, so a flag-only admin could use every settings page in the product
 * except this one.
 *
 * Session ownership is a separate gate and is unaffected — being an admin
 * has never meant being allowed to run evals inside someone else's session,
 * and it still doesn't.
 */
async function requireEvalAccess(
  sessionId: string,
): Promise<{ organizationId: string; session: SessionRecord }> {
  const authSession = await getServerSession();
  if (!authSession?.user?.id) {
    throw new Error(SIGNED_OUT);
  }
  const userId = authSession.user.id;

  const session = await getSessionById(sessionId);
  if (!session || session.userId !== userId) {
    throw new Error(NOT_YOURS);
  }

  const [role, admin] = await Promise.all([
    getMemberRole(userId),
    isAdmin(userId),
  ]);
  if (!(role || admin)) {
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
