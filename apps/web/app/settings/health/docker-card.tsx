import type { DockerPreflightResult } from "@paco/sandbox";
import { Container } from "lucide-react";
import type { HealthMetric } from "@/lib/admin/health-actions";
import { setupFailureMessage } from "@/lib/sandbox/setup-failure-copy";
import { HealthCard } from "./health-card";
import { HealthNotice, UnavailableNotice } from "./health-notice";

/**
 * Whether this host's Docker can actually run a sandbox.
 *
 * Every chat runs in a container, so a Docker that cannot serve one means no
 * chat works at all — and the ways it fails are hard to tell apart from the
 * outside. An unreachable daemon, a daemon that refuses this process, and a
 * rootless daemon all surface downstream as some flavour of "the sandbox did
 * not start", which historically sent operators to debug the wrong thing.
 *
 * This card asks the daemon directly, before anyone starts a chat, so the
 * answer arrives while an operator is looking at a page about health rather
 * than mid-conversation.
 *
 * The copy is NOT written here. `dockerPreflight`'s `state` values are
 * deliberately the same strings as `ProvisioningFailureReason`, so the same
 * `setupFailureMessage` a failed chat shows is reused verbatim — a reader who
 * sees this card and then sees a chat fail gets one explanation, not two that
 * have to be reconciled. `result.message` is for logs and never rendered.
 */
export function DockerCard({
  docker,
}: {
  docker: HealthMetric<DockerPreflightResult>;
}) {
  return (
    <HealthCard icon={Container} title="Docker">
      {docker.status === "unavailable" ? (
        <UnavailableNotice reason="Docker could not be checked — the daemon did not answer in time." />
      ) : (
        <DockerBody result={docker.data} />
      )}
    </HealthCard>
  );
}

function DockerBody({ result }: { result: DockerPreflightResult }) {
  // Healthy renders plain, not as a notice: `HealthNotice` has no "ok" tone
  // on purpose — the cards on this page reserve an alert for something an
  // operator has to act on, so a green banner on every visit would train them
  // to skim past the one that matters.
  // Narrowed on `state`, not on `usable`: they always agree, but only the
  // discriminated union tells the compiler that the branch below cannot be
  // "ok" — and `setupFailureMessage` accepts failure reasons only.
  if (result.state === "ok") {
    return (
      <p className="text-base-content/70 text-sm">
        Docker is reachable and can run chats
        {result.serverVersion ? ` (daemon ${result.serverVersion})` : ""}.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <HealthNotice tone="error">
        {setupFailureMessage(result.state)}
      </HealthNotice>
      <p className="text-base-content/60 text-xs">
        Chats cannot start until this is resolved — every chat runs inside a
        container.
      </p>
    </div>
  );
}
