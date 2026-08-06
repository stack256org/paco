import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { usageEvents, users } from "@/lib/db/schema";
import { listAvailableModels } from "@/lib/model-catalog";
import { estimateModelUsageCost, type AvailableModelCost } from "@/lib/models";

/**
 * What each member's usage has cost, over some trailing window.
 *
 * Reuses the same cost arithmetic the usage page and the profile page's
 * spend estimate already use (`estimateModelUsageCost` in `lib/models.ts`,
 * fed the published per-million-token rates from
 * `lib/model-catalog.ts#listAvailableModels`) rather than deriving a second
 * one — two places computing money differently is worse than either.
 */
export type SpendPerMember = {
  userId: string;
  username: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  /**
   * Tokens this member used against a model with no known price. Counted in
   * `inputTokens`/`outputTokens` above, but never folded into `costUsd` — an
   * unpriced token contributes zero to the total because there is nothing to
   * charge it at, not because it was free.
   */
  unpricedTokens: number;
};

export type SpendReport = {
  windowDays: number;
  totalCostUsd: number;
  totalTokens: number;
  /** Sum of every member's `unpricedTokens` — see that field for why this exists. */
  unpricedTokens: number;
  perMember: SpendPerMember[];
};

/** One usage row, already joined to the user it belongs to. */
export type SpendEventRow = {
  userId: string;
  username: string;
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
 * Aggregates raw usage rows into a per-member spend report.
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

  const perMember = new Map<string, SpendPerMember>();
  let totalTokens = 0;
  let totalCostUsd = 0;
  let unpricedTokens = 0;

  for (const event of events) {
    if (event.createdAt < windowStart) {
      continue;
    }

    const tokens = event.inputTokens + event.outputTokens;
    const cost = estimateModelUsageCost(event, priceFor(event.modelId));

    const member = perMember.get(event.userId) ?? {
      userId: event.userId,
      username: event.username,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      unpricedTokens: 0,
    };

    member.inputTokens += event.inputTokens;
    member.cachedInputTokens += event.cachedInputTokens;
    member.outputTokens += event.outputTokens;
    if (cost === undefined) {
      member.unpricedTokens += tokens;
      unpricedTokens += tokens;
    } else {
      member.costUsd += cost;
      totalCostUsd += cost;
    }
    perMember.set(event.userId, member);

    totalTokens += tokens;
  }

  return {
    windowDays,
    totalCostUsd,
    totalTokens,
    unpricedTokens,
    // Highest spender first — the one ranking a health page actually wants;
    // ties broken by id so the order is still deterministic.
    perMember: [...perMember.values()].sort(
      (a, b) => b.costUsd - a.costUsd || a.userId.localeCompare(b.userId),
    ),
  };
}

/**
 * Reads every usage event in the last `windowDays` days, joined to the user
 * it belongs to, and aggregates it into a spend report.
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
      userId: usageEvents.userId,
      username: users.username,
      modelId: usageEvents.modelId,
      inputTokens: usageEvents.inputTokens,
      cachedInputTokens: usageEvents.cachedInputTokens,
      outputTokens: usageEvents.outputTokens,
      createdAt: usageEvents.createdAt,
    })
    .from(usageEvents)
    .innerJoin(users, eq(usageEvents.userId, users.id))
    .where(sql`${usageEvents.createdAt} >= ${since.toISOString()}`);

  const priceById = new Map(
    listAvailableModels().map((model) => [model.id, model.cost]),
  );
  const priceFor: ModelPriceLookup = (modelId) =>
    modelId ? priceById.get(modelId) : undefined;

  return aggregateSpend(rows, windowDays, now, priceFor);
}
