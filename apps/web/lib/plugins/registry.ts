import "server-only";

import { PluginHost } from "@paco/plugin-host";
import { discoverPlugin } from "@paco/plugin-kit";
import { listPlugins } from "@/lib/db/plugins";
import type { PluginRow } from "@/lib/db/schema";
import { buildCapabilityHandlers } from "@/lib/plugins/capability-handlers";
import { pluginDir } from "@/lib/plugins/install";

/**
 * The running plugin hosts, keyed by plugin id.
 *
 * Cached on `globalThis`, not a module-level variable — same reasoning as
 * `lib/db/client.ts`'s connection pool: a dev-server reload builds a fresh
 * module graph, and a module-level `Map` would otherwise leave the previous
 * reload's worker processes running while a second registry started new
 * ones on top of them.
 */
const globalForPluginRegistry = globalThis as typeof globalThis & {
  __pacoPluginRegistry?: Map<string, PluginHost>;
  __pacoPluginStartLocks?: Map<string, Promise<void>>;
};

/** The module-level singleton registry of running plugin hosts. */
export function getPluginRegistry(): Map<string, PluginHost> {
  globalForPluginRegistry.__pacoPluginRegistry ??= new Map();
  return globalForPluginRegistry.__pacoPluginRegistry;
}

/**
 * In-flight `start()` calls, keyed by plugin id — so two callers racing
 * `ensurePluginsStarted()` for the same not-yet-running plugin await the
 * same `start()` rather than spawning two worker processes for it.
 */
function startLocks(): Map<string, Promise<void>> {
  globalForPluginRegistry.__pacoPluginStartLocks ??= new Map();
  return globalForPluginRegistry.__pacoPluginStartLocks;
}

/**
 * Discovers and starts one enabled plugin's host, then registers it.
 *
 * Never throws: a plugin whose manifest fails to (re-)discover on disk, or
 * whose worker fails to start, is logged and left out of the registry — the
 * spec's degradation invariant (Section 2) says a broken plugin must not
 * fail a turn or request, and the caller here may be serving one.
 */
async function startOnePlugin(row: PluginRow): Promise<void> {
  const discovered = await discoverPlugin(pluginDir(row.id));
  if (!discovered.ok) {
    console.error("plugin registry: failed to discover plugin, skipping", {
      id: row.id,
      error: discovered.error,
    });
    return;
  }

  const host = new PluginHost({
    descriptor: discovered.plugin,
    grantedCapabilities: row.grantedCapabilities,
    // TODO(consentedNetDomains): this column now exists on the row
    // (`lib/db/schema.ts`) and is the operator-consented snapshot — prefer
    // it here once every write path (install/grant) is confirmed to keep it
    // in sync, rather than mixing two sources of truth mid-migration.
    netDomains: row.consentedNetDomains,
    handlers: buildCapabilityHandlers(row),
  });

  try {
    await host.start();
    getPluginRegistry().set(row.id, host);
  } catch (error) {
    console.error("plugin registry: failed to start plugin, skipping", {
      id: row.id,
      error,
    });
  }
}

/**
 * Ensures every enabled plugin has a running host in `getPluginRegistry()`,
 * starting any that are missing.
 *
 * Safe to call repeatedly and concurrently: a plugin already in the
 * registry is left alone, and a plugin whose start is already in flight is
 * awaited rather than started twice. Never throws — even a failure to list
 * plugins from the database is logged and treated as "nothing to start"
 * rather than propagated, so a caller building an agent turn's MCP config
 * never fails the turn over the plugin subsystem.
 */
export async function ensurePluginsStarted(): Promise<void> {
  let rows: PluginRow[];
  try {
    rows = await listPlugins();
  } catch (error) {
    console.error("plugin registry: failed to list plugins", { error });
    return;
  }

  const registry = getPluginRegistry();
  const locks = startLocks();

  await Promise.all(
    rows
      .filter((row) => row.enabled && !registry.has(row.id))
      .map((row) => {
        const existing = locks.get(row.id);
        if (existing) {
          return existing;
        }
        const started = startOnePlugin(row).finally(() => {
          locks.delete(row.id);
        });
        locks.set(row.id, started);
        return started;
      }),
  );
}
