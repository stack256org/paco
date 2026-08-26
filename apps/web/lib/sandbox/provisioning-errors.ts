// No "server-only" marker: this is a plain error class with no server
// dependencies, and the workflow tests import it directly.

/**
 * Why setting up a workspace failed, as a value rather than a sentence.
 *
 * The workflow used to decide what to tell the user by matching the text of
 * these errors — `error.message === "Session is archived"`, and an
 * `includes("Connect GitHub")`. That quietly made user-facing copy
 * load-bearing: rewriting either message, which any plain-language pass would
 * do, would have silently dropped the specific explanation and left everyone
 * with the generic one, with no test failing and nothing to notice.
 *
 * The reason is now a field. The message can say anything.
 */
export type ProvisioningFailureReason =
  /** Paco knew the answer before it started. */
  | "archived"
  | "github-not-connected"
  /** The host cannot run a workspace at all. */
  | "docker-missing"
  | "docker-not-running"
  /** The daemon answered and refused this process — usually a group, not a fault. */
  | "docker-permission"
  /** Rootless Docker. Paco cannot share a workspace across its user namespace. */
  | "docker-rootless"
  | "image-missing"
  /** The project could not be fetched. */
  | "repo-not-found"
  | "repo-auth-failed"
  | "network"
  /** The machine ran out of something. */
  | "disk-full"
  | "timed-out"
  /** Nothing recognised it. */
  | "unknown";

export class ProvisioningError extends Error {
  readonly reason: ProvisioningFailureReason;

  constructor(reason: ProvisioningFailureReason, message: string) {
    super(message);
    this.name = "ProvisioningError";
    this.reason = reason;
  }
}

export function provisioningFailureReason(
  error: unknown,
): ProvisioningFailureReason | null {
  return error instanceof ProvisioningError ? error.reason : null;
}
