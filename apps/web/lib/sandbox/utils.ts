import type { SandboxState } from "@paco/sandbox";

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function getLegacySandboxId(state: unknown): string | null {
  if (!state || typeof state !== "object") {
    return null;
  }

  const sandboxId = (state as { sandboxId?: unknown }).sandboxId;
  return hasNonEmptyString(sandboxId) ? sandboxId : null;
}

export function getSessionSandboxName(sessionId: string): string {
  return `session_${sessionId}`;
}

export function getPersistentSandboxName(state: unknown): string | null {
  if (!state || typeof state !== "object") {
    return null;
  }

  const sandboxName = (state as { sandboxName?: unknown }).sandboxName;
  return hasNonEmptyString(sandboxName) ? sandboxName : null;
}

export function getResumableSandboxName(state: unknown): string | null {
  return getPersistentSandboxName(state) ?? getLegacySandboxId(state);
}

export function hasResumableSandboxState(state: unknown): boolean {
  return getResumableSandboxName(state) !== null;
}

/**
 * Whether the state records a container that was live when it was written.
 *
 * `containerId` and `expiresAt` are exactly the fields
 * {@link clearSandboxState} drops — that function's job is "clear runtime state
 * while preserving durable resume state", so they are what "runtime state"
 * means here. `sandboxName` survives hibernation and archival and therefore
 * says nothing about whether anything is running.
 */
function hasLiveContainerRecord(state: unknown): boolean {
  if (!state || typeof state !== "object") {
    return false;
  }

  const { containerId, expiresAt } = state as {
    containerId?: unknown;
    expiresAt?: unknown;
  };

  return hasNonEmptyString(containerId) || typeof expiresAt === "number";
}

/**
 * Check whether the sandbox is hibernated but restorable.
 *
 * Drives `hasPausedWorkspace` on `/api/sandbox/status` and `/api/sandbox/reconnect`,
 * which is what tells the UI to offer "Resume" rather than "Create sandbox".
 *
 * This used to be `hasResumableSandboxState(s) && !hasRuntimeSandboxState(s)`
 * while `hasRuntimeSandboxState` was itself defined as
 * `hasResumableSandboxState(s)` — i.e. `X && !X`, constantly false, so no
 * session ever reported a snapshot. The two predicates now test different
 * fields: a resume handle (durable) versus a live container (runtime).
 */
export function hasPausedSandboxState(state: unknown): boolean {
  return hasResumableSandboxState(state) && !hasLiveContainerRecord(state);
}

/**
 * Type guard to check if a sandbox is active and ready to accept operations.
 *
 * Docker sandboxes have no lease: the container is named, and connecting is
 * idempotent — it reconnects to a running container, restarts a stopped one, or
 * creates a missing one. So a state carrying a sandbox name is always usable,
 * and `expiresAt` (when present) is only an idle-stop hint, not an expiry that
 * invalidates the sandbox.
 */
export function isSandboxActive(
  state: SandboxState | null | undefined,
): state is SandboxState {
  if (!state) return false;

  return hasResumableSandboxState(state);
}

/**
 * Check if we can perform operations on a sandbox session (stop, extend, etc.).
 *
 * Deliberately the *loose* test, for the same reason as `isSandboxActive`:
 * stopping or extending is addressed by name, and connecting is idempotent, so
 * a name is all these operations need. Requiring a recorded container here
 * would stop the lifecycle workflow from hibernating a container it can still
 * reach.
 */
export function canOperateOnSandbox(
  state: SandboxState | null | undefined,
): state is SandboxState {
  if (!state) return false;
  return hasResumableSandboxState(state);
}

/**
 * Check if an unknown value represents sandbox state with live runtime data.
 *
 * "Runtime" means a container was recorded as running when this state was
 * persisted — the fields `clearSandboxState` strips on hibernate, archive and
 * unavailability. A bare resume handle is not runtime state; it is what is left
 * *after* the runtime went away, and reading it as runtime made
 * {@link hasPausedSandboxState} unsatisfiable.
 */
export function hasRuntimeSandboxState(state: unknown): boolean {
  return hasResumableSandboxState(state) && hasLiveContainerRecord(state);
}

function isSandboxNotFoundError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("status code 404") ||
    normalized.includes("sandbox not found")
  );
}

/**
 * Check if an error message indicates the sandbox VM is permanently unavailable.
 */
export function isSandboxUnavailableError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("expected a stream of command data") ||
    normalized.includes("status code 410") ||
    normalized.includes("status code 404") ||
    normalized.includes("sandbox is stopped") ||
    normalized.includes("sandbox not found") ||
    normalized.includes("sandbox probe failed")
  );
}

/**
 * Clear sandbox runtime state while preserving durable resume state when available.
 */
export function clearSandboxState(
  state: SandboxState | null | undefined,
): SandboxState | null {
  if (!state) return null;

  const sandboxName = getPersistentSandboxName(state);
  const sandboxId = sandboxName ? null : getLegacySandboxId(state);

  return {
    type: state.type,
    ...(sandboxName ? { sandboxName } : {}),
    ...(sandboxId ? { sandboxId } : {}),
  } as SandboxState;
}

/**
 * Clear both runtime state and any saved resume handle.
 */
export function clearSandboxResumeState(
  state: SandboxState | null | undefined,
): SandboxState | null {
  if (!state) return null;

  return { type: state.type } as SandboxState;
}

/**
 * Clear sandbox state after an unavailable-sandbox error.
 * Hard 404s wipe the saved resume handle; other unavailable errors preserve it.
 */
export function clearUnavailableSandboxState(
  state: SandboxState | null | undefined,
  message: string,
): SandboxState | null {
  return isSandboxNotFoundError(message)
    ? clearSandboxResumeState(state)
    : clearSandboxState(state);
}
