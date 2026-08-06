"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getStorageReport,
  reclaimContainerGroup,
  reclaimWorkspaceDirectory,
} from "@/lib/admin/storage-actions";
import type { ContainerGroup } from "@/lib/reaping/reclaim";
import type { StorageReport } from "@/lib/reaping/types";

/**
 * Loading, and reloading, the picture of what Paco is using.
 *
 * Every reclaim refreshes afterwards rather than editing the report in place.
 * The report is a measurement, and a measurement that is patched by the client
 * to show what it hoped happened is no longer a measurement — the number on
 * screen after a removal has to come from `du` again, not from arithmetic.
 *
 * It is not polled. Measuring means walking every workspace with `du` and
 * running git in each one, which is far too expensive to do on a timer while
 * somebody has the tab open; the report says when it was taken and there is a
 * button to take another.
 */
export function useStorageReport() {
  const [report, setReport] = useState<StorageReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      setReport(await getStorageReport());
    } catch {
      setError(
        "We couldn't measure what Paco is using. Reload the page and try again.",
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Remove a group of containers.
   *
   * Resolves to a sentence when something went wrong and null when it worked,
   * which is the shape `useDestructiveConfirm` wants: the dialog stays open and
   * reports the failure itself rather than closing on an action that did not
   * happen.
   */
  const removeContainers = useCallback(
    async (group: ContainerGroup): Promise<string | null> => {
      try {
        const result = await reclaimContainerGroup(group);
        await refresh();
        if (!result.ok) {
          const [first] = result.failed;
          return first
            ? `Removed ${result.removed.length}. ${first.name} could not be removed: ${first.error}`
            : "Some containers could not be removed.";
        }
        return null;
      } catch {
        await refresh();
        return "We couldn't reach Docker. Check that it is running, then try again.";
      }
    },
    [refresh],
  );

  const removeWorkspace = useCallback(
    async (name: string, acknowledgeUnsavedWork: boolean) => {
      try {
        const result = await reclaimWorkspaceDirectory({
          name,
          acknowledgeUnsavedWork,
        });
        await refresh();
        return result.ok ? null : (result.error ?? "That didn't work.");
      } catch {
        await refresh();
        return "We couldn't remove that workspace. Reload the page and try again.";
      }
    },
    [refresh],
  );

  return {
    report,
    isLoading,
    error,
    refresh,
    removeContainers,
    removeWorkspace,
  };
}
