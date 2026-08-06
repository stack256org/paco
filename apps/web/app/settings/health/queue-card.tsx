import { Mail } from "lucide-react";
import type { HealthMetric } from "@/lib/admin/health-actions";
import type { QueueHealth } from "@/lib/health/queue-health";
import { pluralize } from "@/lib/reaping/format-bytes";
import { formatAge } from "./format-health";
import { HealthCard } from "./health-card";
import { HealthNotice, UnavailableNotice } from "./health-notice";

/**
 * Whether pg-boss — the queue behind every sign-in and invitation email — is
 * actually moving.
 *
 * This is the highest-value card on the page. A stalled queue looks exactly
 * like "nothing is happening", and the symptom an operator hears about is "I
 * never got the email" — which sends them to debug SMTP, not the queue. So
 * this says, in those terms, what a stall means, rather than reporting a job
 * count and leaving the translation to whoever reads it at 2am.
 */
export function QueueCard({ queue }: { queue: HealthMetric<QueueHealth> }) {
  return (
    <HealthCard icon={Mail} title="Queue">
      {queue.status === "unavailable" ? (
        <UnavailableNotice reason="the job queue could not be read — Postgres may be unreachable, or pg-boss has not started yet." />
      ) : (
        <QueueBody queue={queue.data} />
      )}
    </HealthCard>
  );
}

function QueueBody({ queue }: { queue: QueueHealth }) {
  return (
    <div className="space-y-4">
      <QueueHeadline queue={queue} />

      <div className="stats stats-vertical w-full border border-base-content/10 sm:stats-horizontal">
        <div className="stat">
          <div className="stat-title">Pending</div>
          <div className="stat-value text-2xl">{queue.pending}</div>
        </div>
        <div className="stat">
          <div className="stat-title">Failed, last hour</div>
          <div className="stat-value text-2xl">{queue.failedLastHour}</div>
        </div>
        <div className="stat">
          <div className="stat-title">Oldest pending</div>
          <div className="stat-value text-2xl">
            {queue.oldestPendingAgeSeconds === null
              ? "—"
              : formatAge(queue.oldestPendingAgeSeconds)}
          </div>
        </div>
      </div>
    </div>
  );
}

function QueueHeadline({ queue }: { queue: QueueHealth }) {
  if (queue.state === "failing") {
    return (
      <HealthNotice tone="error">
        Sign-in and invitation emails are failing to send —{" "}
        {pluralize(queue.failedLastHour, "job", "jobs")} failed in the last
        hour. Check the mail server settings in{" "}
        <span className="font-medium">Settings → Admin</span>.
      </HealthNotice>
    );
  }

  if (queue.state === "backed-up") {
    const age =
      queue.oldestPendingAgeSeconds === null
        ? "a while"
        : formatAge(queue.oldestPendingAgeSeconds);
    return (
      <HealthNotice tone="warning">
        Sign-in and invitation emails are not being delivered — the oldest
        pending job has been waiting {age}, long enough that a magic link sent
        then has already expired. Check that the mail server is reachable.
      </HealthNotice>
    );
  }

  if (queue.state === "working") {
    return (
      <p className="text-sm text-base-content/70">
        Delivering normally — {pluralize(queue.pending, "job", "jobs")} pending.
      </p>
    );
  }

  return (
    <p className="text-sm text-base-content/60">Idle — nothing waiting.</p>
  );
}
