import { Clock } from "lucide-react";
import type { HealthMetric } from "@/lib/admin/health-actions";
import type { QueueHealth } from "@/lib/health/queue-health";
import { pluralize } from "@/lib/reaping/format-bytes";
import { formatAge } from "./format-health";
import { HealthCard } from "./health-card";
import { HealthNotice, UnavailableNotice } from "./health-notice";

/**
 * Whether pg-boss — the queue behind every cron schedule — is actually
 * moving.
 *
 * This is the highest-value card on the page. A stalled queue looks exactly
 * like "nothing is happening", and the symptom an operator hears about is "my
 * schedule didn't run" — which sends them to debug the schedule itself, not
 * the queue. So this says, in those terms, what a stall means, rather than
 * reporting a job count and leaving the translation to whoever reads it at
 * 2am.
 */
export function QueueCard({ queue }: { queue: HealthMetric<QueueHealth> }) {
  return (
    <HealthCard icon={Clock} title="Queue">
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
        Scheduled tasks are failing to run —{" "}
        {pluralize(queue.failedLastHour, "job", "jobs")} failed in the last
        hour.
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
        Scheduled tasks are not running on time — the oldest pending job has
        been waiting {age}.
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
