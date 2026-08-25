import "server-only";

import { PluginHost, type RegisteredTool } from "@paco/plugin-host";
import { discoverPlugin } from "@paco/plugin-kit";
import { getPlugin, listPlugins } from "@/lib/db/plugins";
import type { PluginRow } from "@/lib/db/schema";
import { buildCapabilityHandlers } from "@/lib/plugins/capability-handlers";
import { pluginDir, recheckPluginIntegrity } from "@/lib/plugins/install";
import type { EnabledPluginForMcp } from "@/lib/plugins/mcp-bridge";
import { getPluginEventFanout } from "@/lib/plugins/plugin-fanout";

/**
 * How many times `ensurePluginsStarted` will try to bring a crashed plugin
 * back up before it gives up and leaves it `"crashed"` for good (spec
 * Section 2 degradation invariant, and the plan's Task 12 brief).
 *
 * There is deliberately no timed backoff between attempts: each attempt
 * happens on whatever cadence something already calls
 * `ensurePluginsStarted` (instrumentation at boot, sandbox provisioning
 * before a turn, the plugin-tools route), which naturally spaces attempts
 * across real work rather than this module sleeping — a plugin subsystem
 * must never block or slow down a turn (spec Section 2), and a `setTimeout`
 * delay here would do exactly that to whichever caller happened to trigger
 * the retry.
 */
const MAX_RESTART_ATTEMPTS = 3;

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
  /** A started host's registered tools, for `listEnabledPluginsForMcp`. */
  __pacoPluginTools?: Map<string, RegisteredTool[]>;
  /** How many consecutive crash-restart attempts a plugin has used up. */
  __pacoPluginRestartAttempts?: Map<string, number>;
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

function pluginToolsMap(): Map<string, RegisteredTool[]> {
  globalForPluginRegistry.__pacoPluginTools ??= new Map();
  return globalForPluginRegistry.__pacoPluginTools;
}

function restartAttemptsMap(): Map<string, number> {
  globalForPluginRegistry.__pacoPluginRestartAttempts ??= new Map();
  return globalForPluginRegistry.__pacoPluginRestartAttempts;
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
 * Logs a crashed plugin the shape an operator (or a log aggregator) can
 * grep for, and lets `onCrash` observers elsewhere (there are none yet)
 * attach later without this host needing to know about them in advance.
 *
 * Registered on every host `discoverAndStartHost` constructs, whether or
 * not `start()` itself goes on to succeed — a crash can happen well after a
 * successful start, and `PluginHost.onCrash` fires for both cases (see its
 * own doc comment).
 */
function logCrash(pluginId: string, error: string): void {
  console.error("plugin/crashed", { id: pluginId, error });
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
 *
 * On success, the returned host is also registered with the process-wide
 * session-event fan-out (`plugin-fanout.ts`) and its `onCrash` callback is
 * wired to `logCrash` — every caller that starts a host this way gets both
 * for free, rather than each of `startOnePlugin`/`startPluginHost` having
 * to remember to do it themselves.
 */
async function discoverAndStartHost(
  row: PluginRow,
): Promise<
  | { ok: true; host: PluginHost; tools: RegisteredTool[] }
  | { ok: false; error: string }
> {
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
  host.onCrash((error) => logCrash(row.id, error));

  let tools: RegisteredTool[];
  try {
    ({ tools } = await host.start());
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }

  const fanout = getPluginEventFanout();
  fanout.register(host);
  fanout.start();

  return { ok: true, host, tools };
}

/**
 * Records a host that just (re-)started: puts it in the registry, remembers
 * its registered tools for `listEnabledPluginsForMcp`, and resets its
 * restart-attempt counter — a plugin that is actually running again has
 * earned a fresh set of `MAX_RESTART_ATTEMPTS` the next time it crashes,
 * rather than carrying a grudge from a crash episode it has since recovered
 * from.
 */
function registerStartedHost(
  pluginId: string,
  host: PluginHost,
  tools: RegisteredTool[],
): void {
  getPluginRegistry().set(pluginId, host);
  pluginToolsMap().set(pluginId, tools);
  restartAttemptsMap().delete(pluginId);
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
  registerStartedHost(row.id, result.host, result.tools);
}

/**
 * Whether `row` needs a start attempt this pass: either it has no host at
 * all yet, or its host has crashed and there is at least one restart
 * attempt left (`MAX_RESTART_ATTEMPTS`, spec Section 2 degradation
 * invariant plus the plan's Task 12 brief). A host that is `"starting"`,
 * `"running"`, or `"stopped"` is left alone — only `"crashed"` is a retry
 * candidate, and only up to the attempt ceiling.
 */
function needsStartAttempt(
  row: PluginRow,
  registry: Map<string, PluginHost>,
  attempts: Map<string, number>,
): boolean {
  if (!row.enabled) {
    return false;
  }
  const existing = registry.get(row.id);
  if (!existing) {
    return true;
  }
  if (existing.state !== "crashed") {
    return false;
  }
  return (attempts.get(row.id) ?? 0) < MAX_RESTART_ATTEMPTS;
}

/**
 * Attempts to restart one crashed plugin, counting the attempt against
 * `MAX_RESTART_ATTEMPTS` regardless of outcome. A successful restart resets
 * the counter (`registerStartedHost`); a failed one leaves the previous
 * (still `"crashed"`) host in the registry untouched, so its state — and an
 * operator's `pluginStatusAction` view of it — stay accurate either way.
 */
async function restartCrashedPlugin(row: PluginRow): Promise<void> {
  const attempts = restartAttemptsMap();
  attempts.set(row.id, (attempts.get(row.id) ?? 0) + 1);

  const result = await discoverAndStartHost(row);
  if (!result.ok) {
    logStartFailure(row.id, result.error);
    return;
  }
  registerStartedHost(row.id, result.host, result.tools);
}

/**
 * Ensures every enabled plugin has a running host in `getPluginRegistry()`,
 * starting any that are missing and restarting any that have crashed (up to
 * `MAX_RESTART_ATTEMPTS`).
 *
 * Safe to call repeatedly and concurrently: a plugin already running is
 * left alone, and a plugin whose start is already in flight is awaited
 * rather than started twice. Never throws — even a failure to list plugins
 * from the database is logged and treated as "nothing to start" rather than
 * propagated, so a caller building an agent turn's MCP config never fails
 * the turn over the plugin subsystem.
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
  const attempts = restartAttemptsMap();

  await Promise.all(
    rows
      .filter((row) => needsStartAttempt(row, registry, attempts))
      .map((row) => {
        const existing = locks.get(row.id);
        if (existing) {
          return existing;
        }
        const isRestart = registry.has(row.id);
        const started = (
          isRestart ? restartCrashedPlugin(row) : startOnePlugin(row)
        ).then(() => ({ ok: true as const }));
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

    registerStartedHost(pluginId, result.host, result.tools);
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
  getPluginEventFanout().unregister(host);
  // `PluginHost.stop()` never rejects (see its own doc comment) — a plugin
  // that is already gone, or that crashed, stops cleanly either way.
  await host.stop();
  registry.delete(pluginId);
  pluginToolsMap().delete(pluginId);
  restartAttemptsMap().delete(pluginId);
}

/**
 * Every enabled, currently-running plugin's manifest and registered tools,
 * shaped exactly for `buildPluginMcpConfig` (`lib/plugins/mcp-bridge.ts`).
 *
 * This is the "running registry" half of Task 12's `AgentCallOptions.mcpServers`
 * fix: `resolveChatMcpServers` (`lib/agent/chat-environment.ts`) calls
 * `ensurePluginsStarted()` first, then this, so a plugin that is enabled but
 * whose host has crashed (or is still `"starting"`) is correctly left out —
 * bridging tools for a host that cannot actually run them would just turn
 * every call into a timeout instead of an absent tool.
 *
 * Never throws: a failure to list plugins is logged and treated as "no
 * plugins to bridge", the same posture as `ensurePluginsStarted` itself.
 */
export async function listEnabledPluginsForMcp(): Promise<
  EnabledPluginForMcp[]
> {
  let rows: PluginRow[];
  try {
    rows = await listPlugins();
  } catch (error) {
    console.error("plugin registry: failed to list plugins for mcp", {
      error,
    });
    return [];
  }

  const registry = getPluginRegistry();
  const tools = pluginToolsMap();

  const enabled: EnabledPluginForMcp[] = [];
  for (const row of rows) {
    if (!row.enabled) {
      continue;
    }
    const host = registry.get(row.id);
    if (host?.state !== "running") {
      continue;
    }
    enabled.push({
      id: row.id,
      manifest: row.manifest,
      tools: tools.get(row.id) ?? [],
    });
  }
  return enabled;
}
