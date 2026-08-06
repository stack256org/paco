import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { getErrorCode } from "@/lib/db/error-code";

/**
 * Whether pg-boss — the queue that delivers magic links and invitation
 * emails (see `lib/jobs/queue.ts`) — is actually moving jobs.
 *
 * This is the highest-value item on the instance-health page: when the queue
 * stalls, sign-in silently stops working. Nothing else says so — the symptom
 * ("I never got the email") looks exactly like a broken SMTP server and is
 * not, so this has to be checked directly rather than inferred.
 */
export type QueueHealthState = "idle" | "working" | "backed-up" | "failing";

export type QueueCounts = {
  pending: number;
  failedLastHour: number;
  oldestPendingAgeSeconds: number | null;
};

export type QueueHealth = QueueCounts & { state: QueueHealthState };

/**
 * How long a job may sit pending before the queue counts as "backed up".
 *
 * A magic link expires in `MAGIC_LINK_EXPIRY_SECONDS` (600 seconds — see
 * `lib/auth/config.ts`). A sign-in email still sitting in the queue after two
 * minutes has already burned a fifth of its useful life; by the time a human
 * notices "I never got the email" and goes looking, it is nearly, or already,
 * too late to matter. That is the justification for this number — not a
 * round guess.
 */
const BACKED_UP_AGE_SECONDS = 120;

/**
 * Pure classification over the three counts, so the thresholds are testable
 * without a database.
 *
 * `failing` outranks `backed-up`: a queue that is losing jobs is a worse sign
 * than one that is merely slow, even when it also happens to have an old
 * pending job.
 */
export function classifyQueue(counts: QueueCounts): QueueHealth {
  if (counts.failedLastHour > 0) {
    return { ...counts, state: "failing" };
  }
  if (
    counts.oldestPendingAgeSeconds !== null &&
    counts.oldestPendingAgeSeconds >= BACKED_UP_AGE_SECONDS
  ) {
    return { ...counts, state: "backed-up" };
  }
  if (counts.pending > 0) {
    return { ...counts, state: "working" };
  }
  return { ...counts, state: "idle" };
}

/** Postgres error codes for a relation or schema that does not exist yet. */
const UNDEFINED_TABLE = "42P01";
const UNDEFINED_SCHEMA = "3F000";

/**
 * A missing `pgboss` schema or table — pg-boss has never started, e.g. on a
 * very fresh install. Used only to decide whether a failure is loud or quiet
 * in the logs; it is never a reason to report the queue as empty. See
 * `readQueueHealth` below.
 */
function isMissingRelation(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === UNDEFINED_TABLE || code === UNDEFINED_SCHEMA;
}

function firstRow(rows: unknown): Record<string, unknown> | undefined {
  const row = Array.isArray(rows) ? rows[0] : undefined;
  return typeof row === "object" && row !== null
    ? (row as Record<string, unknown>)
    : undefined;
}

/** A count column is never absent, only zero. */
function firstRowCount(rows: unknown, key: string): number {
  const value = firstRow(rows)?.[key];
  return typeof value === "number" ? value : Number(value ?? 0) || 0;
}

/** An age column is genuinely `null` when there is nothing pending to age. */
function firstRowNullableNumber(rows: unknown, key: string): number | null {
  const value = firstRow(rows)?.[key];
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "number" ? value : Number(value) || 0;
}

/**
 * `pgboss.job` is `PARTITION BY LIST (name)` (see pg-boss's own
 * `createTableJob`): every queue's jobs live in a partition of it, whether
 * that is the shared `job_common` partition or one dedicated to a single
 * queue. Querying the parent table, as below, transparently reads across all
 * of them — there is no separate "archive" table in this pg-boss version to
 * also check.
 */
async function countPending(): Promise<number> {
  const rows = await db.execute(sql`
    select count(*)::int as count
    from pgboss.job
    where state in ('created', 'retry', 'active')
  `);
  return firstRowCount(rows, "count");
}

async function countFailedLastHour(): Promise<number> {
  const rows = await db.execute(sql`
    select count(*)::int as count
    from pgboss.job
    where state = 'failed' and completed_on >= now() - interval '1 hour'
  `);
  return firstRowCount(rows, "count");
}

async function readOldestPendingAgeSeconds(): Promise<number | null> {
  const rows = await db.execute(sql`
    select extract(epoch from (now() - min(created_on)))::int as age
    from pgboss.job
    where state in ('created', 'retry', 'active')
  `);
  return firstRowNullableNumber(rows, "age");
}

/**
 * Reads pg-boss's own tables in the `pgboss` schema — never the application
 * tables, which pg-boss does not touch (see `lib/jobs/queue.ts`).
 *
 * Rejects on any failure rather than degrading to zero. This used to catch
 * every query and default to `pending: 0, failedLastHour: 0,
 * oldestPendingAgeSeconds: null` — which `classifyQueue` reads as `"idle"`.
 * That made "Postgres is unreachable" and "the `pgboss` schema does not
 * exist because pg-boss never started" both render as "Idle — nothing
 * waiting," on the one card whose entire job is to say when mail delivery is
 * actually broken. `Promise.allSettled` in `lib/admin/health-actions.ts`
 * already turns a rejection into an honest `"unavailable"`; swallowing here
 * on top of that only threw away the information the caller needed. A
 * missing relation is still checked for — not to swallow it, but to log it
 * quietly rather than as a fresh alarm every time an install has not started
 * pg-boss yet. The only path to `"idle"` is the queries succeeding and
 * genuinely returning zero.
 */
export async function readQueueHealth(): Promise<QueueHealth> {
  const [pending, failedLastHour, oldestPendingAgeSeconds] = await Promise.all([
    countPending().catch((error: unknown) => {
      if (!isMissingRelation(error)) {
        console.error("[health] failed to count pending jobs:", error);
      }
      throw error;
    }),
    countFailedLastHour().catch((error: unknown) => {
      if (!isMissingRelation(error)) {
        console.error("[health] failed to count failed jobs:", error);
      }
      throw error;
    }),
    readOldestPendingAgeSeconds().catch((error: unknown) => {
      if (!isMissingRelation(error)) {
        console.error("[health] failed to read oldest pending job age:", error);
      }
      throw error;
    }),
  ]);

  return classifyQueue({ pending, failedLastHour, oldestPendingAgeSeconds });
}
