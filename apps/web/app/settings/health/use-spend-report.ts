"use client";

import { useEffect, useState } from "react";
import { getSpendReport, type HealthMetric } from "@/lib/admin/health-actions";
import type { SpendReport } from "@/lib/health/spend";
import {
  DEFAULT_SPEND_WINDOW_DAYS,
  SPEND_WINDOW_OPTIONS,
} from "@/lib/health/spend-window";

export { SPEND_WINDOW_OPTIONS };

/**
 * The spend card's own data, separate from the rest of the page.
 *
 * `getInstanceHealth` already reads a `DEFAULT_SPEND_WINDOW_DAYS`-day
 * report, so this starts from that instead of fetching again on mount, and
 * adopts it again every time the caller hands over a new one — which is what
 * "Check again" does. A previous version captured `initialSpend` in
 * `useState` once and never looked at it again: every other card refreshed
 * on "Check again" while this one kept showing whatever it had loaded the
 * first time, with nothing on screen to say it was now stale. The effect
 * below re-runs whenever `initialSpend` changes *or* the selected window
 * changes, so both a fresh page load and a manual window switch land on the
 * same, single fetch path — and `measuredAtMs` gives the operator something
 * to check staleness against even when the data underneath happens not to
 * have moved.
 */
export function useSpendReport(initialSpend: HealthMetric<SpendReport>) {
  const [windowDays, setWindowDays] = useState<number>(
    DEFAULT_SPEND_WINDOW_DAYS,
  );
  const [spend, setSpend] = useState(initialSpend);
  const [isLoading, setIsLoading] = useState(false);
  const [measuredAtMs, setMeasuredAtMs] = useState(() => Date.now());

  useEffect(() => {
    if (windowDays === DEFAULT_SPEND_WINDOW_DAYS) {
      setSpend(initialSpend);
      setMeasuredAtMs(Date.now());
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    getSpendReport(windowDays)
      .then((data) => {
        if (!cancelled) {
          setSpend({ status: "ok", data });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSpend({ status: "unavailable" });
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
          setMeasuredAtMs(Date.now());
        }
      });

    return () => {
      cancelled = true;
    };
  }, [initialSpend, windowDays]);

  return { spend, windowDays, setWindowDays, isLoading, measuredAtMs };
}
