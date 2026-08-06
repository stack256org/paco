"use client";

import { useCallback, useEffect, useState } from "react";
import { getInstanceHealth } from "@/lib/admin/health-actions";
import type { InstanceHealth } from "@/lib/admin/health-actions";

/**
 * Loading, and reloading, the queue/migrations/spend part of the
 * instance-health report.
 *
 * Disk and containers are deliberately not here — see
 * `use-instance-storage-health.ts` — because that measurement is the one
 * expensive thing on this page (`du` over every workspace, serially) and
 * used to gate these three cheap, indexed reads behind it. Everything left
 * in this hook really is cheap to recompute, which is what makes a manual
 * "Check again" button enough; there is no reason to poll on a timer for a
 * page an operator opens to check on, not to leave open. `getInstanceHealth`
 * also bounds each metric with a timeout server-side, so a wedged Postgres
 * connection resolves to "unavailable" instead of leaving this hook's
 * promise pending forever.
 */
export function useInstanceHealth() {
  const [health, setHealth] = useState<InstanceHealth | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      setHealth(await getInstanceHealth());
    } catch {
      setError(
        "We couldn't load instance health. Reload the page and try again.",
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { health, isLoading, error, refresh };
}
