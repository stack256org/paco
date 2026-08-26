import "server-only";

import { start, getRun } from "workflow/api";
import { sandboxProvisioningWorkflow } from "@/app/workflows/sandbox-provisioning";
import {
  clearSessionSandboxProvisioningRunIdIfOwned,
  claimSessionSandboxProvisioningRunId,
  getSessionById,
  updateSession,
} from "@/lib/db/sessions";
import { isSandboxActive } from "@/lib/sandbox/utils";

/**
 * Why a kick attached the caller to no run at all.
 *
 * `skipped` used to be one undifferentiated answer, and the caller had nothing
 * left to do but read `lifecycleError` and guess. Two of these three are
 * definite answers about the session, and the third is not an answer about the
 * session at all — it says only that *this* caller lost a race, which is not a
 * reason to tell anyone their workspace failed.
 */
export type ProvisioningKickSkipReason =
  | "session-not-found"
  | "session-archived"
  /** Another kick owns provisioning for this session; this one started nothing. */
  | "superseded";

type KickSandboxProvisioningResult =
  | {
      status: "started" | "existing";
      runId: string;
      skipReason?: undefined;
    }
  | {
      status: "active";
      runId?: undefined;
      skipReason?: undefined;
    }
  | {
      status: "skipped";
      runId?: undefined;
      skipReason: ProvisioningKickSkipReason;
    };

/**
 * How a provisioning run ended, for a caller that was waiting on it.
 *
 * Note what is *not* here: failure. `Run.returnValue` rejects when the run
 * failed (`WorkflowRunFailedError`), so a failed run never resolves to one of
 * these — it throws out of `waitForSandboxProvisioningRun`, carrying the
 * `[paco:setup-reason=…]` tag that survives the workflow boundary. Everything
 * that resolves here is a run that did not fail, and `superseded` in particular
 * is a run that was taken over by a newer one before it did any work.
 */
export type ProvisioningRunOutcome = {
  status: "provisioned" | "superseded" | "abandoned";
};

/**
 * Narrow `runProvisioning`'s return value, which crosses the workflow boundary
 * as `unknown` and must not be trusted to have any particular shape.
 */
function readProvisioningRunOutcome(value: unknown): ProvisioningRunOutcome {
  if (typeof value !== "object" || value === null) {
    return { status: "abandoned" };
  }
  if (!("skipped" in value) || value.skipped !== true) {
    return { status: "provisioned" };
  }
  const reason = "reason" in value ? value.reason : undefined;
  return { status: reason === "run-replaced" ? "superseded" : "abandoned" };
}

async function isRunStillLive(runId: string): Promise<boolean> {
  try {
    const run = getRun(runId);
    if (!(await run.exists)) {
      return false;
    }
    const status = await run.status;
    return status === "pending" || status === "running";
  } catch {
    return false;
  }
}

export async function kickSandboxProvisioningWorkflow(
  sessionId: string,
): Promise<KickSandboxProvisioningResult> {
  const session = await getSessionById(sessionId);
  if (!session) {
    return { status: "skipped", skipReason: "session-not-found" };
  }
  if (session.status === "archived") {
    return { status: "skipped", skipReason: "session-archived" };
  }
  if (isSandboxActive(session.sandboxState)) {
    return { status: "active" };
  }

  if (session.sandboxProvisioningRunId) {
    const live = await isRunStillLive(session.sandboxProvisioningRunId);
    if (live) {
      return {
        status: "existing",
        runId: session.sandboxProvisioningRunId,
      };
    }
    const cleared = await clearSessionSandboxProvisioningRunIdIfOwned(
      sessionId,
      session.sandboxProvisioningRunId,
    );
    if (!cleared) {
      const latest = await getSessionById(sessionId);
      if (!latest) {
        return { status: "skipped", skipReason: "session-not-found" };
      }
      if (latest.status === "archived") {
        return { status: "skipped", skipReason: "session-archived" };
      }
      if (isSandboxActive(latest.sandboxState)) {
        return { status: "active" };
      }
      if (latest.sandboxProvisioningRunId) {
        return { status: "existing", runId: latest.sandboxProvisioningRunId };
      }
    }
  }

  const run = await start(sandboxProvisioningWorkflow, [sessionId]);
  const claimed = await claimSessionSandboxProvisioningRunId(
    sessionId,
    run.runId,
  );
  if (claimed) {
    // The blanking stays, and it is not the cause of the intermittent generic
    // "we couldn't set up a workspace". It is what makes a *non-empty*
    // `lifecycleError` mean something: without it the column would hold the
    // last failure forever and no reader could tell whether it described the
    // attempt they were waiting on. What was missing was on the reading side —
    // `readSandboxSetupOutlook` now asks whether an attempt is in flight before
    // drawing any conclusion from an empty column.
    await updateSession(sessionId, {
      lifecycleState: "provisioning",
      lifecycleError: null,
    });
    return { status: "started", runId: run.runId };
  }

  const latest = await getSessionById(sessionId);
  if (latest?.sandboxProvisioningRunId === run.runId) {
    await updateSession(sessionId, {
      lifecycleState: "provisioning",
      lifecycleError: null,
    });
    return { status: "started", runId: run.runId };
  }
  if (latest?.sandboxProvisioningRunId) {
    return { status: "existing", runId: latest.sandboxProvisioningRunId };
  }

  try {
    getRun(run.runId).cancel();
  } catch {
    // Best-effort cleanup for a duplicate run.
  }

  // Someone else's run owns this session. Nothing has failed, and this caller
  // has no run of its own to wait on — it has to go and find the one that did
  // win, which is what `skipReason` now lets it know to do.
  return { status: "skipped", skipReason: "superseded" };
}

/**
 * Wait for a provisioning run and say how it ended.
 *
 * Rejects, deliberately, when the run failed: that rejection carries the
 * `[paco:setup-reason=…]` tag through the workflow boundary and is the path
 * that already reports Docker being down correctly. Only runs that did *not*
 * fail resolve to an outcome here.
 */
export async function waitForSandboxProvisioningRun(
  runId: string,
): Promise<ProvisioningRunOutcome> {
  const run = getRun(runId);
  return readProvisioningRunOutcome(await run.returnValue);
}
