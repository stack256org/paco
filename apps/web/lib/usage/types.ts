/**
 * A calendar range, previously imported from react-day-picker.
 *
 * The package was only ever used for this two-field type — the date picker that
 * needed it had no consumers and was removed — so the type is declared here and
 * the dependency dropped.
 */
export interface DateRange {
  from?: Date | undefined;
  to?: Date | undefined;
}

export interface UsagePrInsights {
  trackedPrCount: number;
  sessionsWithPrCount: number;
  openPrCount: number;
  mergedPrCount: number;
  closedPrCount: number;
  mergeRate: number;
}

export interface UsageEfficiencyInsights {
  mainAssistantTurnCount: number;
  averageTokensPerMainTurn: number;
  largestMainTurnTokens: number;
  toolCallsPerMainTurn: number;
  cacheReadRatio: number;
}

export interface UsageCodeInsights {
  linesAdded: number;
  linesRemoved: number;
  totalLinesChanged: number;
}

export interface UsageRepositoryInsight {
  repoOwner: string;
  repoName: string;
  sessionCount: number;
  trackedPrCount: number;
  linesAdded: number;
  linesRemoved: number;
  totalLinesChanged: number;
}

export interface UsageInsights {
  lookbackDays: number;
  pr: UsagePrInsights;
  efficiency: UsageEfficiencyInsights;
  code: UsageCodeInsights;
  topRepositories: UsageRepositoryInsight[];
}
