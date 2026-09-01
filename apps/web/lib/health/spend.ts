import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { usageEvents } from "@/lib/db/schema";
import { listAvailableModels } from "@/lib/model-catalog";
import { estimateModelUsageCost, type AvailableModelCost } from "@/lib/models";

/**
 * What this instance's usage has cost, over some trailing window.
 *
 * Reuses the same cost arithmetic the usage page and the profile page's
 * spend estimate already use (`estimateModelUsageCost` in `lib/models.ts`,
 * fed the published per-million-token rates from
 * `lib/model-catalog.ts#listAvailableModels`) rather than deriving a second
 * one — two places computing money differently is worse than either.
 *
 * This used to break totals down per member, joined against `users`. Phase C
 * removed application-level identity (and `usageEvents.userId` along with
 * it) — the instance has exactly one tenant, so a per-member breakdown had
 * nothing left to distinguish; the health page now shows one instance-wide
 * total instead.
 */
export type SpendReport = {
  windowDays: number;
  totalCostUsd: number;
  totalTokens: number;
  /** Tokens spent against a model with no known price — see `SpendEventRow`. */
  unpricedTokens: number;
};

/** One usage row. */
export type SpendEventRow = {
  modelId: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  createdAt: Date;
};

/** Looks up a model's published rates by id, or `undefined` if unknown. */
export type ModelPriceLookup = (
  modelId: string | null,
) => AvailableModelCost | undefined;

/**
 * Aggregates raw usage rows into a spend report.
 *
 * Pure over its inputs — including `now`, so the window boundary is
 * testable without the clock actually moving — which is what lets this run
 * without a database in a test.
 */
export function aggregateSpend(
  events: SpendEventRow[],
  windowDays: number,
  now: Date,
  priceFor: ModelPriceLookup,
): SpendReport {
  const windowStart = new Date(now);
  windowStart.setDate(windowStart.getDate() - windowDays);

  let totalTokens = 0;
  let totalCostUsd = 0;
  let unpricedTokens = 0;

  for (const event of events) {
    if (event.createdAt < windowStart) {
      continue;
    }

    const tokens = event.inputTokens + event.outputTokens;
    const cost = estimateModelUsageCost(event, priceFor(event.modelId));

    if (cost === undefined) {
      unpricedTokens += tokens;
    } else {
      totalCostUsd += cost;
    }

    totalTokens += tokens;
  }

  return {
    windowDays,
    totalCostUsd,
    totalTokens,
    unpricedTokens,
  };
}

/**
 * Reads every usage event in the last `windowDays` days and aggregates it
 * into a spend report.
 *
 * The SQL filter on `created_at` is an optimization, not the only place the
 * window is enforced — `aggregateSpend` re-checks it against `now`, which is
 * also what makes that boundary testable without touching the database.
 */
export async function readSpend(windowDays: number): Promise<SpendReport> {
  const now = new Date();
  const since = new Date(now);
  since.setDate(since.getDate() - windowDays);

  const rows = await db
    .select({
      modelId: usageEvents.modelId,
      inputTokens: usageEvents.inputTokens,
      cachedInputTokens: usageEvents.cachedInputTokens,
      outputTokens: usageEvents.outputTokens,
      createdAt: usageEvents.createdAt,
    })
    .from(usageEvents)
    .where(sql`${usageEvents.createdAt} >= ${since.toISOString()}`);

  const priceById = new Map(
    listAvailableModels().map((model) => [model.id, model.cost]),
  );
  const priceFor: ModelPriceLookup = (modelId) =>
    modelId ? priceById.get(modelId) : undefined;

  return aggregateSpend(rows, windowDays, now, priceFor);
}
