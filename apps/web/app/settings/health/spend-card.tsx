import { formatTokens } from "@paco/shared/lib/tool-state";
import { DollarSign } from "lucide-react";
import type { HealthMetric } from "@/lib/admin/health-actions";
import type { SpendReport } from "@/lib/health/spend";
import { cn } from "@/lib/utils";
import { formatUsd } from "./format-health";
import { HealthCard } from "./health-card";
import { HealthNotice, UnavailableNotice } from "./health-notice";
import { SPEND_WINDOW_OPTIONS, useSpendReport } from "./use-spend-report";

/**
 * This instance's spend over a selectable window.
 *
 * Reuses the same cost arithmetic as the profile and usage pages
 * (`estimateModelUsageCost`) rather than a second formula. Tokens spent on a
 * model with no published price never fold into the total silently — they
 * are called out instead, because a token with no price is unpriced, not
 * free.
 *
 * Used to break this down per member, joined against `users`. Phase C
 * removed application-level identity — the instance has exactly one tenant,
 * so there is nothing left to break a total down by.
 */
export function SpendCard({
  spend: initialSpend,
}: {
  spend: HealthMetric<SpendReport>;
}) {
  const { spend, windowDays, setWindowDays, isLoading, measuredAtMs } =
    useSpendReport(initialSpend);

  return (
    <HealthCard icon={DollarSign} title="Spend">
      <div className="flex items-center justify-between gap-3">
        <label className="text-sm text-base-content/60" htmlFor="spend-window">
          Window
        </label>
        <select
          className="select select-sm w-auto"
          disabled={isLoading}
          id="spend-window"
          onChange={(event) => setWindowDays(Number(event.target.value))}
          value={windowDays}
        >
          {SPEND_WINDOW_OPTIONS.map((days) => (
            <option key={days} value={days}>
              Last {days} days
            </option>
          ))}
        </select>
      </div>

      {spend.status === "unavailable" ? (
        <UnavailableNotice reason="usage data could not be read — Postgres may be unreachable." />
      ) : (
        <SpendBody isLoading={isLoading} spend={spend.data} />
      )}

      <p className="text-base-content/50 text-xs">
        Measured at {new Date(measuredAtMs).toLocaleTimeString()}.
      </p>
    </HealthCard>
  );
}

function SpendBody({
  spend,
  isLoading,
}: {
  spend: SpendReport;
  isLoading: boolean;
}) {
  return (
    <div className={cn("space-y-4", isLoading && "opacity-60")}>
      {spend.unpricedTokens > 0 ? (
        <HealthNotice tone="warning">
          {formatTokens(spend.unpricedTokens)} tokens were spent on a model with
          no published price and are not counted in the totals below — unpriced,
          not free.
        </HealthNotice>
      ) : null}

      <div className="stats stats-vertical w-full border border-base-content/10 sm:stats-horizontal">
        <div className="stat">
          <div className="stat-title">Total spend</div>
          <div className="stat-value text-2xl">
            {formatUsd(spend.totalCostUsd)}
          </div>
        </div>
        <div className="stat">
          <div className="stat-title">Total tokens</div>
          <div className="stat-value text-2xl">
            {formatTokens(spend.totalTokens)}
          </div>
        </div>
      </div>

      {spend.totalTokens === 0 ? (
        <p className="text-sm text-base-content/60">No usage in this window.</p>
      ) : null}
    </div>
  );
}
