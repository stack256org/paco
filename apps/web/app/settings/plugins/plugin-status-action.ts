"use server";

import type { PluginHostState } from "@paco/plugin-host";
import { requireAdmin } from "@/lib/admin/require-admin";
import { listPlugins } from "@/lib/db/plugins";
import { getPluginRegistry } from "@/lib/plugins/registry";

/**
 * A plugin's host state as the Plugins page shows it — `PluginHostState`
 * plus `"not-running"` for a plugin that has no entry in the registry at
 * all (disabled, or enabled but not yet started this process).
 *
 * This is the third dead-code fix the plan's Task 12 brief calls out: the
 * registry already tracks `PluginHost.state` per plugin (including
 * `"crashed"`, from the restart-with-backoff logic in
 * `lib/plugins/registry.ts`), but nothing surfaced it to an operator. A
 * crashed plugin degrades silently — the spec's Section 2 invariant — but
 * "silently" should still mean visible in Settings, not invisible.
 */
export type PluginStatus = PluginHostState | "not-running";

/** Every installed plugin's current host state, keyed by plugin id. */
export async function pluginStatusAction(): Promise<
  Record<string, PluginStatus>
> {
  await requireAdmin();

  const rows = await listPlugins();
  const registry = getPluginRegistry();

  const status: Record<string, PluginStatus> = {};
  for (const row of rows) {
    status[row.id] = registry.get(row.id)?.state ?? "not-running";
  }
  return status;
}
