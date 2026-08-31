import { and, sql } from "drizzle-orm";
import {
  buildUsageInsights,
  type UsageAggregateRow,
  type UsageSessionInsightRow,
} from "@/lib/usage/compute-insights";
import {
  getDateRangeDaysInclusive,
  type UsageDateRange,
} from "@/lib/usage/date-range";
import type { UsageInsights } from "@/lib/usage/types";
import { db } from "./client";
import { sessions, usageEvents } from "./schema";

const EMPTY_USAGE_AGGREGATE: UsageAggregateRow = {
  totalInputTokens: 0,
  totalCachedInputTokens: 0,
  totalOutputTokens: 0,
  totalToolCallCount: 0,
  mainInputTokens: 0,
  mainOutputTokens: 0,
  mainAssistantTurnCount: 0,
  largestMainTurnTokens: 0,
};

export interface UsageInsightsOptions {
  days?: number;
  range?: UsageDateRange;
  allTime?: boolean;
}

/**
 * Unfiltered by `userId`: the instance has exactly one tenant, so its usage
 * events are every row in range, not a subset of them.
 */
function buildUsageEventsWhereClause(options?: UsageInsightsOptions) {
  if (options?.range) {
    return sql`date(${usageEvents.createdAt}) >= ${options.range.from} and date(${usageEvents.createdAt}) <= ${options.range.to}`;
  }

  if (options?.allTime) {
    return sql`true`;
  }

  const days = options?.days ?? 280;
  const since = new Date();
  since.setDate(since.getDate() - days);

  return sql`${usageEvents.createdAt} >= ${since.toISOString()}`;
}

/** Unfiltered by `userId`, same reasoning as `buildUsageEventsWhereClause`. */
function buildSessionsWhereClause(options?: UsageInsightsOptions) {
  if (options?.range) {
    return and(
      sql`date(${sessions.updatedAt}) >= ${options.range.from}`,
      sql`date(${sessions.updatedAt}) <= ${options.range.to}`,
    );
  }

  if (options?.allTime) {
    return sql`true`;
  }

  const days = options?.days ?? 280;
  const since = new Date();
  since.setDate(since.getDate() - days);

  return sql`${sessions.updatedAt} >= ${since.toISOString()}`;
}

function getLookbackDays(options?: UsageInsightsOptions): number {
  if (options?.range) {
    return getDateRangeDaysInclusive(options.range);
  }

  if (options?.allTime) {
    return 0;
  }

  return options?.days ?? 280;
}

export async function getUsageInsights(
  options?: UsageInsightsOptions,
): Promise<UsageInsights> {
  const [aggregateRows, sessionRows] = await Promise.all([
    db
      .select({
        totalInputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::double precision`,
        totalCachedInputTokens: sql<number>`coalesce(sum(${usageEvents.cachedInputTokens}), 0)::double precision`,
        totalOutputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)::double precision`,
        totalToolCallCount: sql<number>`coalesce(sum(${usageEvents.toolCallCount}), 0)::double precision`,
        mainInputTokens: sql<number>`coalesce(sum(case when ${usageEvents.agentType} = 'main' then ${usageEvents.inputTokens} else 0 end), 0)::double precision`,
        mainOutputTokens: sql<number>`coalesce(sum(case when ${usageEvents.agentType} = 'main' then ${usageEvents.outputTokens} else 0 end), 0)::double precision`,
        mainAssistantTurnCount: sql<number>`coalesce(sum(case when ${usageEvents.agentType} = 'main' then 1 else 0 end), 0)::double precision`,
        largestMainTurnTokens: sql<number>`coalesce(max(case when ${usageEvents.agentType} = 'main' then cast(${usageEvents.inputTokens} as bigint) + cast(${usageEvents.outputTokens} as bigint) end), 0)::double precision`,
      })
      .from(usageEvents)
      .where(buildUsageEventsWhereClause(options)),
    db
      .select({
        repoOwner: sessions.repoOwner,
        repoName: sessions.repoName,
        prNumber: sessions.prNumber,
        prStatus: sessions.prStatus,
        linesAdded: sessions.linesAdded,
        linesRemoved: sessions.linesRemoved,
        updatedAt: sessions.updatedAt,
      })
      .from(sessions)
      .where(buildSessionsWhereClause(options)),
  ]);

  const aggregate = aggregateRows[0] ?? EMPTY_USAGE_AGGREGATE;

  return buildUsageInsights({
    lookbackDays: getLookbackDays(options),
    aggregate,
    sessions: sessionRows as UsageSessionInsightRow[],
  });
}
