import "server-only";

import { PluginHost } from "@paco/plugin-host";
import { discoverPlugin } from "@paco/plugin-kit";
import { getPlugin, listPlugins } from "@/lib/db/plugins";
import type { PluginRow } from "@/lib/db/schema";
import { buildCapabilityHandlers } from "@/lib/plugins/capability-handlers";
import { pluginDir, recheckPluginIntegrity } from "@/lib/plugins/install";

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
  __pacoPluginStartLocks?: Map<
    string,
    Promise<{ ok: true } | { ok: false; error: string }>
  >;
};

/** The module-level singleton registry of running plugin hosts. */
export function getPluginRegistry(): Map<string, PluginHost> {
  globalForPluginRegistry.__pacoPluginRegistry ??= new Map();
  return globalForPluginRegistry.__pacoPluginRegistry;
}

/**
 * In-flight `start()` calls, keyed by plugin id — so two callers racing to
 * start the same not-yet-running plugin (whether both via
 * `ensurePluginsStarted()`, both via `startPluginHost()`, or one of each)
 * await the same `start()` rather than spawning two worker processes for it.
 */
function startLocks(): Map<
  string,
  Promise<{ ok: true } | { ok: false; error: string }>
> {
  globalForPluginRegistry.__pacoPluginStartLocks ??= new Map();
  return globalForPluginRegistry.__pacoPluginStartLocks;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Which Node binary a plugin worker is spawned with.
 *
 * `packages/plugin-host/SECURITY.md`'s "Required runtime" section is
 * unambiguous: a hardened worker refuses to start below Node 24, because
 * that is the version where the runtime's own socket gate backs up the
 * in-process module allowlist. `PluginHost` defaults `nodeExecutable` to
 * `process.execPath` — fine when the Next.js server itself runs on Node
 * >= 24, but not a deployment this file can assume.
 * `PACO_PLUGIN_NODE_EXECUTABLE` is the escape hatch for a host process that
 * doesn't meet that floor itself; `PluginHost.start()` still re-checks
 * whatever this resolves to and throws an actionable error (naming the
 * required version and the fix) if it doesn't qualify, so this is a
 * convenience, not a bypass.
 */
function resolvePluginNodeExecutable(): string {
  return process.env.PACO_PLUGIN_NODE_EXECUTABLE ?? process.execPath;
}

/** Matches `PluginHost.start()`'s Node-floor error message (`host.ts`'s `assertRuntimeIsSupported`). */
const NODE_FLOOR_ERROR_PATTERN = /requires Node >= \d+/;

/**
 * Logs a plugin host start failure, distinguishing a Node-floor failure —
 * every enabled plugin failing the same actionable, fixable way — from an
 * ordinary per-plugin failure (bad manifest, a crash on boot), so an
 * operator scanning logs sees a deployment problem for what it is rather
 * than a wall of identical "plugin X failed to start" lines.
 *
 * `error` is always already a string here (`describeError`'s own output,
 * from `discoverAndStartHost`) rather than the original thrown value —
 * matching against the message text is what `isNodeFloorError` does either
 * way, and passing the string through means one code path handles both a
 * caught `Error` and a discovery failure's plain `error` string alike.
 */
function logStartFailure(pluginId: string, error: string): void {
  if (NODE_FLOOR_ERROR_PATTERN.test(error)) {
    console.error(
      "plugin registry: host runtime is below the required Node floor — every plugin will fail to start until PACO_PLUGIN_NODE_EXECUTABLE points at Node >= 24",
      { id: pluginId, error },
    );
    return;
  }
  console.error("plugin registry: failed to start plugin, skipping", {
    id: pluginId,
    error,
  });
}

/**
 * Discovers `row`'s plugin on disk, constructs its `PluginHost`, and starts
 * it. Never throws: every failure — integrity, discovery, or start — comes
 * back as a value, which both `startOnePlugin` (swallows it into a log
 * line) and `startPluginHost` (also returns it to its caller) build on.
 *
 * `recheckPluginIntegrity` runs first, before the plugin tree is even
 * discovered: `row.contentHash` is what the operator's consent
 * (`setPluginGrants`) was actually given for, and a directory that has
 * changed since then must not run on that stale consent — see that
 * function's doc comment in `lib/plugins/install.ts`. Because this is the
 * one function both `ensurePluginsStarted` and `startPluginHost` call to
 * actually start something, the check applies to every start path there is;
 * nothing here bypasses it.
 */
async function discoverAndStartHost(
  row: PluginRow,
): Promise<{ ok: true; host: PluginHost } | { ok: false; error: string }> {
  const integrity = await recheckPluginIntegrity(row.id, row.contentHash);
  if (!integrity.ok) {
    return integrity;
  }

  const discovered = await discoverPlugin(pluginDir(row.id));
  if (!discovered.ok) {
    return { ok: false, error: discovered.error };
  }

  const host = new PluginHost({
    descriptor: discovered.plugin,
    grantedCapabilities: row.grantedCapabilities,
    netDomains: row.consentedNetDomains,
    handlers: buildCapabilityHandlers(row),
    nodeExecutable: resolvePluginNodeExecutable(),
  });

  try {
    await host.start();
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }

  return { ok: true, host };
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
  const result = await discoverAndStartHost(row);
  if (!result.ok) {
    logStartFailure(row.id, result.error);
    return;
  }
  getPluginRegistry().set(row.id, result.host);
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
        const started = startOnePlugin(row).then(() => ({ ok: true as const }));
        const tracked = started.finally(() => {
          locks.delete(row.id);
        });
        locks.set(row.id, tracked);
        return tracked;
      }),
  );
}

/**
 * Starts one plugin's host and registers it, if it isn't already running.
 *
 * Unlike `ensurePluginsStarted` (which starts every enabled plugin at once
 * and only ever logs a failure), this is the entry point for a caller that
 * needs to know whether ONE specific plugin's host actually came up — an
 * operator granting capabilities and clicking "enable"
 * (`app/settings/plugins/actions.ts`) must see a failed start (including
 * the Node-floor error from `PluginHost.start()`), not a silent skip. The
 * failure is still logged here too (`logStartFailure`), so it shows up in
 * server logs the same way a mass `ensurePluginsStarted()` failure would,
 * even though the caller also gets it back as a value.
 *
 * Shares `startLocks()` with `ensurePluginsStarted`: a plugin already being
 * started by one path is awaited by the other rather than started twice.
 */
export async function startPluginHost(
  pluginId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const registry = getPluginRegistry();
  if (registry.has(pluginId)) {
    return { ok: true };
  }

  const locks = startLocks();
  const existing = locks.get(pluginId);
  if (existing) {
    return existing;
  }

  const attempt = (async (): Promise<
    { ok: true } | { ok: false; error: string }
  > => {
    const row = await getPlugin(pluginId);
    if (!row) {
      return { ok: false, error: `No plugin installed with id "${pluginId}"` };
    }

    const result = await discoverAndStartHost(row);
    if (!result.ok) {
      logStartFailure(pluginId, result.error);
      return { ok: false, error: result.error };
    }

    registry.set(pluginId, result.host);
    return { ok: true };
  })();

  const tracked = attempt.finally(() => {
    locks.delete(pluginId);
  });
  locks.set(pluginId, tracked);
  return tracked;
}

/** Stops one plugin's host, if it has one running, and drops it from the registry. */
export async function stopPluginHost(pluginId: string): Promise<void> {
  const registry = getPluginRegistry();
  const host = registry.get(pluginId);
  if (!host) {
    return;
  }
  // `PluginHost.stop()` never rejects (see its own doc comment) — a plugin
  // that is already gone, or that crashed, stops cleanly either way.
  await host.stop();
  registry.delete(pluginId);
}
