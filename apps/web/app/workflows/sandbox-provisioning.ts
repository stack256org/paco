import { getWorkflowMetadata } from "workflow";
import {
  claimSessionSandboxProvisioningRunId,
  clearSessionSandboxProvisioningRunIdIfOwned,
  getSessionById,
  updateSession,
} from "@/lib/db/sessions";
import {
  provisionSessionSandbox,
  SessionArchivedDuringProvisioningError,
} from "@/lib/sandbox/provisioning";
import { markSetupReason } from "@/lib/sandbox/provisioning-errors";
import { classifySetupFailure } from "@/lib/sandbox/setup-failure-copy";

async function runProvisioning(sessionId: string, runId: string) {
  "use step";

  const session = await getSessionById(sessionId);
  if (!session) {
    return { skipped: true, reason: "session-not-found" };
  }
  if (session.sandboxProvisioningRunId === null) {
    const claimed = await claimSessionSandboxProvisioningRunId(
      sessionId,
      runId,
    );
    if (!claimed) {
      return { skipped: true, reason: "run-replaced" };
    }
  } else if (session.sandboxProvisioningRunId !== runId) {
    return { skipped: true, reason: "run-replaced" };
  }

  try {
    // Enabled plugins should already be running by the time this session's
    // first turn starts — an `events:subscribe` plugin needs to be
    // registered with the fan-out, and a `tools:register` plugin needs to
    // be up, before there is anything for either to miss. Never throws
    // (see its own doc comment), so a plugin failing to start can never
    // fail sandbox provisioning.
    //
    // Imported dynamically, not statically at module scope: a static
    // import here closes a real cycle — `registry.ts` imports
    // `capability-handlers.ts`, whose `messages:post` handler reaches
    // `app/workflows/chat.ts` -> `chat-sandbox-runtime.ts` ->
    // `lib/sandbox/provisioning-kick.ts` -> straight back to this file.
    // Loading it only when this step actually runs breaks that cycle, the
    // same way `app/workflows/chat.ts` already dynamically imports
    // `chat-environment.ts` for the same underlying reason.
    const { ensurePluginsStarted } = await import("@/lib/plugins/registry");
    await ensurePluginsStarted();

    const result = await provisionSessionSandbox({ sessionId });
    await clearSessionSandboxProvisioningRunIdIfOwned(sessionId, runId);
    return {
      skipped: false,
      sandboxState: result.sandboxState,
    };
  } catch (error) {
    if (error instanceof SessionArchivedDuringProvisioningError) {
      await clearSessionSandboxProvisioningRunIdIfOwned(sessionId, runId);
      return { skipped: true, reason: "session-archived" };
    }

    // Classified here, where the error object still exists, and written into
    // the string that is persisted. This column is the far side of a durable
    // boundary: `chat-sandbox-runtime.ts` reads it in a different workflow run
    // and has nothing but the text to go on, and `@workflow/core` has by then
    // discarded the class and every field on it (see `provisioning-errors.ts`
    // for what it actually keeps). Deciding the reason on this side, while a
    // `DockerUnusableError` is still a `DockerUnusableError`, is strictly
    // better than re-deriving it from prose over there.
    //
    // `markSetupReason` is a no-op when the message already carries the tag,
    // which every `ProvisioningError` and every preflight failure does — so
    // this only adds one for errors that never knew their own reason.
    const message = error instanceof Error ? error.message : String(error);
    await updateSession(sessionId, {
      lifecycleState: "failed",
      lifecycleError: markSetupReason(classifySetupFailure(error), message),
    });
    await clearSessionSandboxProvisioningRunIdIfOwned(sessionId, runId);
    throw error;
  }
}

export async function sandboxProvisioningWorkflow(sessionId: string) {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  return runProvisioning(sessionId, workflowRunId);
}
