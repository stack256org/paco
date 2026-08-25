"use server";

import { rm } from "node:fs/promises";
import { type Capability, discoverPlugin } from "@paco/plugin-kit";
import { PluginHost } from "@paco/plugin-host";
import { requireAdmin } from "@/lib/admin/require-admin";
import {
  getPlugin,
  PluginGrantEscalationError,
  removePlugin,
  setPluginEnabled,
  setPluginGrants,
} from "@/lib/db/plugins";
import { buildCapabilityHandlers } from "@/lib/plugins/capability-handlers";
import {
  installPlugin,
  pluginDir,
  type InstallSource,
} from "@/lib/plugins/install";
import { getPluginRegistry } from "@/lib/plugins/registry";

/**
 * The gate between "a plugin exists on disk" and "a plugin can act" (spec
 * Section 2 consent invariant): `installPlugin` (`lib/plugins/install.ts`)
 * only ever registers a plugin disabled and ungranted. Every action here is
 * ADMIN-only, via the same `requireAdmin` gate every other settings action
 * file uses (see `app/settings/agents/actions.ts`) — plugin management is an
 * administrative act, not a per-user preference.
 */

/**
 * Parses the three source-string forms the install form accepts into the
 * `InstallSource` `installPlugin` expects:
 *
 * - `"owner/repo"` — a GitHub repo, default branch.
 * - `"owner/repo#ref"` — a GitHub repo pinned to a branch/tag/sha.
 * - `"local:/abs/path"` — a directory already on this machine.
 *
 * Deliberately light on validation: the exact character-class rules for a
 * GitHub repo/ref live in `buildCloneArgs` (`lib/plugins/install.ts`) and are
 * re-checked there regardless of what this function lets through, so
 * duplicating them here would only be a second place for that rule to drift.
 * This function only rejects shapes `installPlugin` could never make sense
 * of at all (an empty repo, a local path that isn't absolute).
 */
export function parseInstallSource(
  source: string,
): { ok: true; source: InstallSource } | { ok: false; error: string } {
  if (source.startsWith("local:")) {
    const path = source.slice("local:".length);
    if (!path.startsWith("/")) {
      return {
        ok: false,
        error: `A local plugin source must be an absolute path, got "${path}"`,
      };
    }
    return { ok: true, source: { kind: "local", path } };
  }

  const hashIndex = source.indexOf("#");
  const repo = hashIndex === -1 ? source : source.slice(0, hashIndex);
  const ref = hashIndex === -1 ? undefined : source.slice(hashIndex + 1);

  if (repo.length === 0) {
    return { ok: false, error: `No repo in source "${source}"` };
  }
  if (ref !== undefined && ref.length === 0) {
    return { ok: false, error: `Empty ref in source "${source}"` };
  }

  return { ok: true, source: { kind: "github", repo, ref } };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Which Node binary a freshly-granted plugin's worker is spawned with.
 *
 * `packages/plugin-host/SECURITY.md`'s "Required runtime" section is
 * unambiguous: a hardened worker refuses to start below Node 24, because
 * that is the version where the runtime's own socket gate backs up the
 * in-process module allowlist. `PluginHost` defaults `nodeExecutable` to
 * `process.execPath` — fine when the Next.js server itself runs on Node
 * >= 24, but not a deployment this file can assume. `PACO_PLUGIN_NODE_EXECUTABLE`
 * is the escape hatch for a host process that doesn't meet that floor
 * itself; `PluginHost.start()` still re-checks whatever this resolves to
 * and throws an actionable error (naming the required version and the fix)
 * if it doesn't qualify, so this is a convenience, not a bypass.
 */
function resolvePluginNodeExecutable(): string {
  return process.env.PACO_PLUGIN_NODE_EXECUTABLE ?? process.execPath;
}

/**
 * Starts one plugin's host and registers it, if it isn't already running.
 *
 * TODO(registry): `lib/plugins/registry.ts` (Task 7, MCP bridge) currently
 * exposes only `ensurePluginsStarted()` — which starts every enabled plugin
 * at once and swallows a start failure into a log line — and
 * `getPluginRegistry()`, the raw shared `Map`. Neither lets a caller start
 * ONE just-granted plugin and see whether it worked, which `grantAndEnableAction`
 * below needs: an operator granting capabilities and clicking "enable" must
 * see a failed host start (including the Node-floor error from
 * `PluginHost.start()`), not a silent skip. This function fills that gap by
 * talking to `PluginHost` directly, but writes into the SAME shared
 * `getPluginRegistry()` map `registry.ts` and `api/internal/plugin-tools/route.ts`
 * already read from, rather than keeping a second map. Once `registry.ts`
 * grows a `startPlugin(id)` that returns (rather than swallows) its error,
 * replace this with a direct import of that instead of duplicating the
 * discover-and-construct logic here.
 */
async function startPluginHost(
  pluginId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const registry = getPluginRegistry();
  if (registry.has(pluginId)) {
    return { ok: true };
  }

  const row = await getPlugin(pluginId);
  if (!row) {
    return { ok: false, error: `No plugin installed with id "${pluginId}"` };
  }

  const discovered = await discoverPlugin(pluginDir(pluginId));
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
    // Surfaced verbatim: this is where the Node-floor error from
    // `PluginHost.start()` ("...requires Node >= 24. Point the
    // `nodeExecutable` option at...") reaches the operator. Swallowing it
    // here would turn a fixable deployment problem into a plugin that just
    // silently never starts.
    return { ok: false, error: describeError(error) };
  }

  registry.set(pluginId, host);
  return { ok: true };
}

/** Stops one plugin's host, if it has one running, and drops it from the registry. */
async function stopPluginHost(pluginId: string): Promise<void> {
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

/**
 * Fetches and registers a plugin — installed disabled, with no granted
 * capabilities (`installPlugin`'s own invariant; nothing here runs it).
 *
 * Returns the manifest's declared capabilities so the consent screen can
 * show the operator exactly what a subsequent `grantAndEnableAction` call
 * would be allowed to grant, before they decide whether to grant any of it.
 */
export async function installPluginAction(input: { source: string }): Promise<{
  ok: boolean;
  pluginId?: string;
  requested?: Capability[];
  error?: string;
}> {
  await requireAdmin();

  const parsed = parseInstallSource(input.source);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  const result = await installPlugin(parsed.source);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { ok: true, pluginId: result.pluginId, requested: result.requested };
}

/**
 * Grants a subset of the plugin's declared capabilities, enables it, and
 * starts its host.
 *
 * `setPluginGrants` (`lib/db/plugins.ts`) is the actual enforcement of the
 * no-self-escalation invariant — this action never re-derives that check,
 * it only turns `PluginGrantEscalationError` into a value instead of an
 * unhandled action throw, so a rejected consent request reads as a form
 * error rather than a crashed page. A host-start failure — Node-floor
 * error included — is returned the same way, verbatim, rather than
 * swallowed: the plugin is left enabled (a later retry, e.g. the next
 * `ensurePluginsStarted()` pass, will try again) but this call reports the
 * failure so the operator sees it immediately.
 */
export async function grantAndEnableAction(input: {
  pluginId: string;
  grants: Capability[];
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();

  try {
    await setPluginGrants(input.pluginId, input.grants);
  } catch (error) {
    if (error instanceof PluginGrantEscalationError) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: describeError(error) };
  }

  await setPluginEnabled(input.pluginId, true);

  const started = await startPluginHost(input.pluginId);
  if (!started.ok) {
    return { ok: false, error: started.error };
  }

  return { ok: true };
}

/** Stops a plugin's host (if running) and marks it disabled. */
export async function disablePluginAction(input: {
  pluginId: string;
}): Promise<{ ok: boolean }> {
  await requireAdmin();

  await stopPluginHost(input.pluginId);
  await setPluginEnabled(input.pluginId, false);

  return { ok: true };
}

/**
 * Uninstalls a plugin: stops its host, deletes its directory from disk, and
 * removes its row.
 *
 * Stops the host before touching the filesystem — a running worker still
 * has the (about to be deleted) plugin directory open for reads, and
 * `PluginHost.stop()` is the only thing here that waits for the process to
 * actually exit rather than just asking it to.
 */
export async function removePluginAction(input: {
  pluginId: string;
}): Promise<{ ok: boolean }> {
  await requireAdmin();

  await stopPluginHost(input.pluginId);
  await rm(pluginDir(input.pluginId), { recursive: true, force: true });
  await removePlugin(input.pluginId);

  return { ok: true };
}
