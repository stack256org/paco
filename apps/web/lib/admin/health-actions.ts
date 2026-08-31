"use server";

import { dockerPreflight, type DockerPreflightResult } from "@paco/sandbox";
import { z } from "zod";
import {
  readMigrationHealth,
  type MigrationHealth,
} from "@/lib/health/migration-health";
import { readQueueHealth, type QueueHealth } from "@/lib/health/queue-health";
import { readSpend, type SpendReport } from "@/lib/health/spend";
import {
  DEFAULT_SPEND_WINDOW_DAYS,
  SPEND_WINDOW_OPTIONS,
} from "@/lib/health/spend-window";
import type { StorageReport } from "@/lib/reaping/types";
import { getStorageReport } from "./storage-actions";
import { withTimeout } from "./with-timeout";

/**
 * The one read-only page an operator opens to answer "is this instance
 * healthy, and what is it costing me?"
 *
 * Each metric is gathered independently with `Promise.allSettled`, never
 * `Promise.all` — one metric failing (a query erroring, a table not yet
 * existing) must not blank the whole page. A rejected part becomes an
 * explicit `"unavailable"` in the response: that is part of the returned
 * type, not something the UI infers, so a gap can never be mistaken for a
 * clean zero.
 *
 * Every metric is also wrapped in `withTimeout` — a wedged Postgres
 * connection used to leave this pending forever, with no bound at all, which
 * showed up as a permanent skeleton and a disabled "Check again" with no
 * error. A timeout is not a real cancellation (nothing here can abort a
 * `postgres.js` query mid-flight), but it is enough to make the *page* stop
 * waiting and report the gap honestly.
 */

/** How long a Postgres-backed metric (queue, migrations, spend) may take. */
const METRIC_TIMEOUT_MS = 10_000;

export type HealthMetric<T> =
  | { status: "ok"; data: T }
  | { status: "unavailable" };

export type DiskHealth = {
  workspaceCount: number;
  workspaceBytes: number;
  orphanedWorkspaceCount: number;
  orphanedWorkspaceBytes: number;
  reclaimableBytes: number;
  /** How many workspaces `du` failed to measure — folded into the bytes above as 0, not excluded from them. */
  unmeasuredWorkspaceCount: number;
};

export type SandboxHealth = {
  containerCount: number;
  runningContainerCount: number;
  containerWritableBytes: number;
  orphanedContainerCount: number;
};

/**
 * The cheap metrics, loaded automatically. Disk and containers are
 * deliberately not here — see `getInstanceStorageHealth` below.
 */
export type InstanceHealth = {
  queue: HealthMetric<QueueHealth>;
  migrations: HealthMetric<MigrationHealth>;
  docker: HealthMetric<DockerPreflightResult>;
  spend: HealthMetric<SpendReport>;
};

export type InstanceStorageHealth = {
  disk: HealthMetric<DiskHealth>;
  sandboxes: HealthMetric<SandboxHealth>;
};

function toMetric<T>(result: PromiseSettledResult<T>): HealthMetric<T> {
  if (result.status === "fulfilled") {
    return { status: "ok", data: result.value };
  }
  console.error("[health] a metric failed to load:", result.reason);
  return { status: "unavailable" };
}

function toDiskMetric(
  result: PromiseSettledResult<StorageReport>,
): HealthMetric<DiskHealth> {
  if (result.status === "rejected") {
    console.error("[health] disk metric failed to load:", result.reason);
    return { status: "unavailable" };
  }

  const { totals } = result.value;
  return {
    status: "ok",
    data: {
      workspaceCount: totals.workspaceCount,
      workspaceBytes: totals.workspaceBytes,
      orphanedWorkspaceCount: totals.orphanedWorkspaceCount,
      orphanedWorkspaceBytes: totals.orphanedWorkspaceBytes,
      reclaimableBytes: totals.reclaimableBytes,
      unmeasuredWorkspaceCount: totals.unmeasuredWorkspaceCount,
    },
  };
}

function toSandboxMetric(
  result: PromiseSettledResult<StorageReport>,
): HealthMetric<SandboxHealth> {
  if (result.status === "rejected") {
    console.error("[health] sandbox metric failed to load:", result.reason);
    return { status: "unavailable" };
  }

  // Disk and container counts come from the same report, but they do not
  // fail together: `buildStorageReport` still measures disk when Docker is
  // unreachable, leaving `containers` empty and `dockerError` set rather
  // than throwing. An empty `containers` array in that case is not "zero
  // containers" — it is "could not ask Docker" — so this reports
  // unavailable instead of a confident, wrong zero.
  if (result.value.dockerError) {
    return { status: "unavailable" };
  }

  const { totals } = result.value;
  return {
    status: "ok",
    data: {
      containerCount: totals.containerCount,
      runningContainerCount: totals.runningContainerCount,
      containerWritableBytes: totals.containerWritableBytes,
      orphanedContainerCount: totals.orphanedContainerCount,
    },
  };
}

/**
 * The action behind the automatic part of the instance-health page.
 *
 * Disk and container measurement (`getInstanceStorageHealth`) used to be
 * gathered here too, in the same `Promise.allSettled`. It does not belong:
 * measuring disk walks every workspace with `du` — up to 120 seconds *per
 * workspace*, serially, plus a git probe and a Docker call on top — while
 * these three are indexed reads that should resolve in milliseconds. Bundled
 * together, the millisecond-scale queries waited behind the multi-minute
 * one, so the whole page's first paint was gated on the single most
 * expensive call in the app. They are now two independent round trips: this
 * one loads automatically, and storage loads only when the operator asks for
 * it (see `use-instance-storage-health.ts`).
 */
export async function getInstanceHealth(): Promise<InstanceHealth> {
  const [queue, migrations, spend, docker] = await Promise.allSettled([
    withTimeout(
      readQueueHealth(),
      METRIC_TIMEOUT_MS,
      "Reading queue health timed out",
    ),
    withTimeout(
      readMigrationHealth(),
      METRIC_TIMEOUT_MS,
      "Reading migration health timed out",
    ),
    withTimeout(
      readSpend(DEFAULT_SPEND_WINDOW_DAYS),
      METRIC_TIMEOUT_MS,
      "Reading spend timed out",
    ),
    /*
     * `dockerPreflight` never throws for a bad daemon — an unreachable,
     * refusing or rootless daemon is a RESULT, not an error, which is the
     * whole point of it. The timeout here is only for a daemon that accepts
     * the connection and then never answers; `dockerPreflight` has its own
     * 10s bound (dockerode has none) and this sits outside it.
     */
    withTimeout(
      dockerPreflight(),
      METRIC_TIMEOUT_MS,
      "Reading Docker health timed out",
    ),
  ]);

  return {
    queue: toMetric(queue),
    migrations: toMetric(migrations),
    spend: toMetric(spend),
    docker: toMetric(docker),
  };
}

/**
 * Disk and container measurement, gathered only when asked for — never as
 * part of the automatic load above. See the module doc on
 * `getInstanceHealth` for why, and `use-instance-storage-health.ts` for the
 * client side of this split.
 *
 * Bounded generously rather than tightly: `snapshotWorkspaces` measures
 * every workspace serially and each `du` may legitimately take up to two
 * minutes (`DU_TIMEOUT_MS` in `lib/reaping/measure-disk.ts`), so an install
 * with many workspaces can take a while without anything being wrong. This
 * timeout exists to catch a *wedged* Docker call or filesystem, not to rush
 * a slow-but-honest measurement.
 */
const STORAGE_TIMEOUT_MS = 180_000;

export async function getInstanceStorageHealth(): Promise<InstanceStorageHealth> {
  const [storage] = await Promise.allSettled([
    withTimeout(
      getStorageReport(),
      STORAGE_TIMEOUT_MS,
      "Measuring disk and containers timed out",
    ),
  ]);

  return {
    disk: toDiskMetric(storage),
    sandboxes: toSandboxMetric(storage),
  };
}

/** The three windows the spend card offers — anything else is rejected. */
const spendWindowDaysSchema = z
  .number()
  .refine(
    (value): value is (typeof SPEND_WINDOW_OPTIONS)[number] =>
      (SPEND_WINDOW_OPTIONS as readonly number[]).includes(value),
    { message: "windowDays must be one of the windows the UI offers." },
  );

/**
 * The spend card offers a window selector, so it re-reads on its own rather
 * than through the combined `getInstanceHealth` — refetching the whole
 * report just to change a spend window would re-run unrelated queries for
 * one card's benefit.
 *
 * `windowDays` is client-supplied and validated here, not trusted because
 * the client only ever sends `7`, `30`, or `90` — a server action is a
 * public RPC endpoint regardless of what the calling component happens to
 * pass. An unvalidated `NaN` throws inside `Date#toISOString`; an
 * unvalidated huge number selects every row in `usage_events` with no
 * `LIMIT` (there is no index on `created_at`) and aggregates all of it in
 * Node memory. Admin-only, so bounded, but still an unbounded table read
 * reachable from a browser.
 */
export async function getSpendReport(windowDays: number): Promise<SpendReport> {
  const parsed = spendWindowDaysSchema.safeParse(windowDays);
  if (!parsed.success) {
    throw new Error("windowDays must be one of the windows the UI offers.");
  }

  return readSpend(parsed.data);
}
