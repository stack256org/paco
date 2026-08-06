"use client";

import { useCallback, useState } from "react";
import {
  getInstanceStorageHealth,
  type InstanceStorageHealth,
} from "@/lib/admin/health-actions";

/**
 * Disk and container measurement for the health page — loaded only when the
 * operator asks for it, never on mount.
 *
 * This used to be part of `useInstanceHealth`, fetched automatically
 * alongside the queue, migrations, and spend cards. It does not belong
 * there: measuring disk walks every workspace with `du`, up to 120 seconds
 * each, serially, plus a Docker call — by far the most expensive thing this
 * page can do — while the other three cards are indexed reads that resolve
 * in milliseconds. Gating the whole page's first paint behind that one call
 * meant a wedged connection anywhere in the chain left every card on screen
 * as a permanent skeleton. This is now its own explicit "Measure" control,
 * matching how `app/settings/admin/use-storage-report.ts` already treats the
 * same measurement on the Admin page.
 */
export function useInstanceStorageHealth() {
  const [storage, setStorage] = useState<InstanceStorageHealth | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [measuredAtMs, setMeasuredAtMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const measure = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      setStorage(await getInstanceStorageHealth());
      setMeasuredAtMs(Date.now());
    } catch {
      setError(
        "We couldn't measure disk and containers. Try again in a moment.",
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { storage, isLoading, measuredAtMs, error, measure };
}
