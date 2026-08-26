import "server-only";

import { connectSandbox, type SandboxState } from "@paco/sandbox";
import {
  getChatsBySessionId,
  getSessionById,
  updateSession,
} from "@/lib/db/sessions";
import {
  SANDBOX_EXPIRES_BUFFER_MS,
  SANDBOX_INACTIVITY_TIMEOUT_MS,
} from "./config";
import {
  canOperateOnSandbox,
  clearSandboxState,
  getPersistentSandboxName,
} from "./utils";

export type SandboxLifecycleState =
  | "provisioning"
  | "active"
  | "hibernating"
  | "hibernated"
  | "restoring"
  | "archived"
  | "failed";

/** Why a lifecycle workflow run was started. Recorded in the run's logs. */
export type SandboxLifecycleReason =
  | "sandbox-created"
  | "timeout-extended"
  | "status-check-overdue";

export interface SandboxLifecycleEvaluationResult {
  action: "skipped" | "hibernated" | "failed";
  reason?: string;
}

/**
 * What a session that has no active sandbox is actually doing.
 *
 * Three states, and the bug this exists to fix was the first two collapsing
 * into the third. A turn that could not get a sandbox used to read one column —
 * `lifecycleError` — and treat an empty one as "failed, cause unknown". But
 * `provisioning-kick.ts` blanks that column at the start of every run, so an
 * empty one is the *normal* reading while provisioning is in flight. The turn
 * reported a failure for a session that had not failed, and reported it in the
 * vaguest words available, because the fallback string it invented
 * ("Workspace setup failed") matches none of the classifier's patterns.
 *
 * The blanking is not the bug and is deliberately kept: it is precisely what
 * makes a *non-empty* `lifecycleError` trustworthy. Without it, the column
 * would hold the last failure forever and every reader would have to guess
 * whether it described the attempt it was waiting on. What was missing was the
 * other half — asking whether an attempt is in flight before concluding
 * anything from an empty column.
 */
export type SandboxSetupOutlook =
  /** An attempt owns this session right now. Nothing has failed. */
  | { status: "in-progress" }
  /** An attempt finished, failed, and recorded why. */
  | { status: "failed"; error: string }
  /** Nothing is in flight, and no attempt left a cause behind. */
  | { status: "no-cause" };

/** The three session columns that answer "is setup running, or over?". */
export interface SandboxSetupOutlookSource {
  lifecycleState: string | null;
  lifecycleError: string | null;
  sandboxProvisioningRunId: string | null;
}

/**
 * Read a session's setup state the way a waiting turn needs to see it.
 *
 * `waitedRunId` is what makes this exact rather than approximate. A kick claims
 * the run id first and blanks `lifecycleError` a statement later, so there is a
 * window in which the row holds a *new* run's id beside an *old* run's error.
 * A reader that trusted the column there would report a superseded attempt's
 * failure as though it were the current one — the very staleness the blanking
 * exists to prevent. Comparing against the run this caller actually waited on
 * closes that window without a schema change: an owner that is not our run is,
 * by definition, an attempt whose outcome we have not observed.
 */
export function readSandboxSetupOutlook(params: {
  session: SandboxSetupOutlookSource;
  /** The run this caller waited on, or null if it had none to wait on. */
  waitedRunId: string | null;
}): SandboxSetupOutlook {
  const { session, waitedRunId } = params;
  const owner = session.sandboxProvisioningRunId;

  if (owner !== null && owner !== waitedRunId) {
    return { status: "in-progress" };
  }

  const error = session.lifecycleError;
  if (error !== null && error !== "") {
    return { status: "failed", error };
  }

  if (owner !== null || session.lifecycleState === "provisioning") {
    return { status: "in-progress" };
  }

  return { status: "no-cause" };
}

interface LifecycleTimingSource {
  hibernateAfter: Date | null;
  lastActivityAt: Date | null;
  sandboxExpiresAt: Date | null;
  updatedAt: Date;
}

type LifecycleUpdate = Parameters<typeof updateSession>[1];

export function getNextLifecycleVersion(
  currentVersion: number | null | undefined,
): number {
  return (currentVersion ?? 0) + 1;
}

export function getSandboxExpiresAtMs(
  sandboxState: SandboxState | null | undefined,
): number | undefined {
  if (!sandboxState || !("expiresAt" in sandboxState)) {
    return undefined;
  }
  return typeof sandboxState.expiresAt === "number"
    ? sandboxState.expiresAt
    : undefined;
}

export function getSandboxExpiresAtDate(
  sandboxState: SandboxState | null | undefined,
): Date | null {
  const expiresAtMs = getSandboxExpiresAtMs(sandboxState);
  return expiresAtMs === undefined ? null : new Date(expiresAtMs);
}

export function buildLifecycleActivityUpdate(
  activityAt: Date = new Date(),
  lifecycleState: Extract<
    SandboxLifecycleState,
    "active" | "restoring"
  > = "active",
): Pick<
  LifecycleUpdate,
  "lifecycleState" | "lifecycleError" | "lastActivityAt" | "hibernateAfter"
> {
  return {
    lifecycleState,
    lifecycleError: null,
    lastActivityAt: activityAt,
    hibernateAfter: new Date(
      activityAt.getTime() + SANDBOX_INACTIVITY_TIMEOUT_MS,
    ),
  };
}

export function buildActiveLifecycleUpdate(
  sandboxState: SandboxState | null | undefined,
  options?: {
    activityAt?: Date;
    lifecycleState?: Extract<SandboxLifecycleState, "active" | "restoring">;
  },
): LifecycleUpdate {
  const activityAt = options?.activityAt ?? new Date();

  return {
    ...buildLifecycleActivityUpdate(
      activityAt,
      options?.lifecycleState ?? "active",
    ),
    sandboxExpiresAt: getSandboxExpiresAtDate(sandboxState),
  };
}

export function buildHibernatedLifecycleUpdate(): LifecycleUpdate {
  return {
    lifecycleState: "hibernated",
    sandboxExpiresAt: null,
    hibernateAfter: null,
    lifecycleRunId: null,
    lifecycleError: null,
  };
}

function getInactivityDueAtMs(source: LifecycleTimingSource): number {
  if (source.hibernateAfter) {
    return source.hibernateAfter.getTime();
  }

  const lastActivityMs =
    source.lastActivityAt?.getTime() ?? source.updatedAt.getTime();
  return lastActivityMs + SANDBOX_INACTIVITY_TIMEOUT_MS;
}

function getExpiryDueAtMs(source: LifecycleTimingSource): number | null {
  if (!source.sandboxExpiresAt) {
    return null;
  }
  return source.sandboxExpiresAt.getTime() - SANDBOX_EXPIRES_BUFFER_MS;
}

export function getLifecycleDueAtMs(source: LifecycleTimingSource): number {
  const inactivityDueAtMs = getInactivityDueAtMs(source);
  const expiryDueAtMs = getExpiryDueAtMs(source);
  if (expiryDueAtMs === null) {
    return inactivityDueAtMs;
  }
  return Math.min(inactivityDueAtMs, expiryDueAtMs);
}

async function hasActiveStreamForSession(sessionId: string): Promise<boolean> {
  const chatsInSession = await getChatsBySessionId(sessionId);
  return chatsInSession.some((chat) => chat.activeStreamId !== null);
}

async function restoreActiveLifecycleState(
  sessionId: string,
  sandboxState: SandboxState,
): Promise<void> {
  await updateSession(sessionId, {
    lifecycleState: "active",
    lifecycleError: null,
    sandboxExpiresAt: getSandboxExpiresAtDate(sandboxState),
  });
}

/**
 * One-shot lifecycle evaluator for workflow orchestration.
 *
 * This performs a single evaluation pass and exits.
 * The durable workflow loops and calls this when it wakes.
 */
export async function evaluateSandboxLifecycle(
  sessionId: string,
  reason: SandboxLifecycleReason,
): Promise<SandboxLifecycleEvaluationResult> {
  const session = await getSessionById(sessionId);
  if (!session) {
    return { action: "skipped", reason: "session-not-found" };
  }

  if (session.status === "archived" || session.lifecycleState === "archived") {
    return { action: "skipped", reason: "session-archived" };
  }

  const sandboxState = session.sandboxState;
  if (!canOperateOnSandbox(sandboxState)) {
    return { action: "skipped", reason: "sandbox-not-operable" };
  }
  if (sandboxState.type !== "docker") {
    return { action: "skipped", reason: "unsupported-sandbox-type" };
  }

  const nowMs = Date.now();
  const dueAtMs = getLifecycleDueAtMs(session);
  const isInactive = nowMs >= dueAtMs;

  if (!isInactive) {
    return { action: "skipped", reason: "not-due-yet" };
  }

  if (await hasActiveStreamForSession(sessionId)) {
    return { action: "skipped", reason: "active-workflow" };
  }

  try {
    await updateSession(sessionId, {
      lifecycleState: "hibernating",
      lifecycleError: null,
    });

    const sandbox = await connectSandbox(sandboxState);

    if (await hasActiveStreamForSession(sessionId)) {
      await restoreActiveLifecycleState(sessionId, sandboxState);
      return { action: "skipped", reason: "active-workflow" };
    }

    const refreshedSession = await getSessionById(sessionId);
    if (
      refreshedSession?.sandboxState &&
      canOperateOnSandbox(refreshedSession.sandboxState)
    ) {
      const lifecycleTimingChanged =
        refreshedSession.lastActivityAt?.getTime() !==
          session.lastActivityAt?.getTime() ||
        refreshedSession.hibernateAfter?.getTime() !==
          session.hibernateAfter?.getTime() ||
        refreshedSession.sandboxExpiresAt?.getTime() !==
          session.sandboxExpiresAt?.getTime();

      if (
        lifecycleTimingChanged &&
        Date.now() < getLifecycleDueAtMs(refreshedSession)
      ) {
        await restoreActiveLifecycleState(
          sessionId,
          refreshedSession.sandboxState,
        );
        return { action: "skipped", reason: "not-due-yet" };
      }
    }

    await sandbox.stop();

    const clearedState = clearSandboxState(sandboxState);
    await updateSession(sessionId, {
      sandboxState: clearedState,
      ...buildHibernatedLifecycleUpdate(),
    });
    console.log(
      `[Lifecycle] Hibernated sandbox for session ${sessionId} (reason=${reason}, sandboxName=${getPersistentSandboxName(clearedState) ?? "none"}).`,
    );
    return { action: "hibernated" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateSession(sessionId, {
      lifecycleState: "failed",
      lifecycleRunId: null,
      lifecycleError: message,
    });
    console.error(
      `[Lifecycle] Failed to evaluate sandbox lifecycle for session ${sessionId}:`,
      error,
    );
    return { action: "failed", reason: message };
  }
}
