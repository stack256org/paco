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
export const PROVISIONING_FAILURE_REASONS = [
  /** Paco knew the answer before it started. */
  "archived",
  "github-not-connected",
  /** The host cannot run a workspace at all. */
  "docker-missing",
  "docker-not-running",
  /** The daemon answered and refused this process — usually a group, not a fault. */
  "docker-permission",
  /** Rootless Docker. Paco cannot share a workspace across its user namespace. */
  "docker-rootless",
  "image-missing",
  /** The project could not be fetched. */
  "repo-not-found",
  "repo-auth-failed",
  "network",
  /** The machine ran out of something. */
  "disk-full",
  /** The machine is too small: fewer CPUs than a sandbox is given. */
  "insufficient-cpu",
  "timed-out",
  /** Nothing recognised it. */
  "unknown",
] as const;

export type ProvisioningFailureReason =
  (typeof PROVISIONING_FAILURE_REASONS)[number];

const REASONS: ReadonlySet<string> = new Set(PROVISIONING_FAILURE_REASONS);

export function isProvisioningFailureReason(
  value: unknown,
): value is ProvisioningFailureReason {
  return typeof value === "string" && REASONS.has(value);
}

/**
 * The one thing that survives the durable workflow: a tag inside the message.
 *
 * A step's throw does not reach the workflow as an object. `@workflow/core`
 * reduces it to `{name, message, stack}` (`dist/types.js`,
 * `normalizeUnknownError`), writes only the string into the `step_failed`
 * event (`dist/runtime/step-handler.js`), and the workflow side rebuilds a
 * bare `FatalError` from that string (`dist/step.js`). Verified against a real
 * failure on this repo: what arrived at the read site was
 *
 *   Error [FatalError]: Step "…//resolveChatSandboxRuntime" failed after 3
 *   retries: Workflow run "wrun_…" failed: Step "…//runProvisioning" failed
 *   after 3 retries: Cannot connect to the Docker daemon at
 *   unix:///var/run/docker.sock. Is the docker daemon running?
 *
 * — the class, `ProvisioningError.reason`, and `DockerUnusableError.state` all
 * gone, the sentence intact but buried under two layers of wrapper prefix.
 *
 * So the reason is written *into* the sentence, as a token designed to be
 * matched. This is deliberately not the same thing as matching our own prose,
 * which `setup-failure-copy.ts` warns against: prose gets rewritten by a
 * plain-language pass and the classification silently degrades, whereas this
 * token means nothing to a reader and exists only to be read back. Wrappers
 * concatenate, so it survives any number of them, in any position.
 */
const REASON_MARKER = /\[paco:setup-reason=([a-z-]+)\]/;

/** The tag `readMarkedSetupReason` looks for. Appended, so logs read normally. */
export function setupReasonMarker(reason: ProvisioningFailureReason): string {
  return `[paco:setup-reason=${reason}]`;
}

/**
 * Append the tag, unless the text already carries one.
 *
 * Idempotent on purpose: a message flows through several layers that each want
 * to guarantee the tag is present (the preflight writes it, the provisioning
 * step writes it onto whatever it persists, `ProvisioningError` writes it on
 * construction), and a doubled tag would put the decoder's answer at the mercy
 * of which one happened to be first.
 */
export function markSetupReason(
  reason: ProvisioningFailureReason,
  message: string,
): string {
  if (REASON_MARKER.test(message)) {
    return message;
  }
  return message
    ? `${message} ${setupReasonMarker(reason)}`
    : setupReasonMarker(reason);
}

/** Read a tag back out of any text that contains one, however wrapped. */
export function readMarkedSetupReason(
  text: string,
): ProvisioningFailureReason | null {
  const match = REASON_MARKER.exec(text);
  if (!match) {
    return null;
  }
  const reason = match[1];
  return isProvisioningFailureReason(reason) ? reason : null;
}

export class ProvisioningError extends Error {
  readonly reason: ProvisioningFailureReason;

  constructor(reason: ProvisioningFailureReason, message: string) {
    // Marked on construction, so the reason is still readable after the
    // workflow has thrown the class away and kept only this string. Nothing
    // renders this message — `setup-failure-copy.ts` turns the reason into the
    // words a user sees — so the tag costs a reader nothing and buys the one
    // guarantee the boundary cannot otherwise give.
    super(markSetupReason(reason, message));
    this.name = "ProvisioningError";
    this.reason = reason;
  }
}

export function provisioningFailureReason(
  error: unknown,
): ProvisioningFailureReason | null {
  return error instanceof ProvisioningError ? error.reason : null;
}
