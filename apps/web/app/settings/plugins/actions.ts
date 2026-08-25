"use server";

import { rm } from "node:fs/promises";
import type { Capability } from "@paco/plugin-kit";
import { requireAdmin } from "@/lib/admin/require-admin";
import {
  ensurePluginIngressSecret,
  getPlugin,
  PluginGrantEscalationError,
  removePlugin,
  setPluginEnabled,
  setPluginGrants,
} from "@/lib/db/plugins";
import {
  installPlugin,
  pluginDir,
  type InstallSource,
} from "@/lib/plugins/install";
import { startPluginHost, stopPluginHost } from "@/lib/plugins/registry";

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
 * Mirrors the private id pattern in `pluginDir()` (`lib/plugins/install.ts`)
 * and `pluginManifestSchema`'s `name` field (`packages/plugin-kit/manifest.ts`).
 *
 * Every action below that takes a `pluginId` gets it straight from the
 * client — unlike `install.ts`'s other callers, which only ever see an id
 * that already came out of a validated manifest or a plugins-table row.
 * Checking it here, first, turns a malformed or path-traversal-shaped id
 * (`"../../../etc"`) into an ordinary field error instead of relying on
 * `pluginDir()` to throw further down — and, for `removePluginAction`,
 * means the check runs before any filesystem call is even attempted.
 * `pluginDir()`'s own validation (plus its symlink-containment check) stays
 * in place regardless, as the backstop for any call site that reaches it a
 * different way.
 */
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

function validatePluginId(
  pluginId: string,
): { ok: true } | { ok: false; error: string } {
  if (!PLUGIN_ID_PATTERN.test(pluginId)) {
    return {
      ok: false,
      error: `Invalid plugin id ${JSON.stringify(pluginId)}`,
    };
  }
  return { ok: true };
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
 * Grants a subset of the plugin's declared capabilities, enables it, mints
 * a channel-ingress secret if the plugin needs one, and starts its host.
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
 *
 * `ensurePluginIngressSecret` (`lib/db/plugins.ts`, Section 6 Task 1) is
 * called only when the plugin's MANIFEST declares `channels:ingress` — a
 * plugin with no `channels/` slot has nothing for `/api/channels/[pluginId]`
 * to authenticate, so it gets no secret. That check is on the manifest's
 * declared capabilities, not on whether this call's `grants` happens to
 * include `channels:ingress`: minting one doesn't itself unlock anything —
 * `PluginHost.deliverIngress` still refuses to deliver unless
 * `channels:ingress` is actually granted — so there's no consent
 * implication to gate it further here. `ensurePluginIngressSecret` itself
 * never regenerates an existing secret and returns the plaintext only when
 * it just minted one, so a re-grant (or a second `grantAndEnableAction`
 * call for an already-enabled plugin) returns no `ingressSecret` at all:
 * this is the ONE response that ever carries the plaintext. No read path
 * anywhere in this file (or `lib/db/plugins.ts`'s `getPlugin`/`listPlugins`)
 * returns it again — the sealed column is all a later read ever sees.
 */
export async function grantAndEnableAction(input: {
  pluginId: string;
  grants: Capability[];
}): Promise<{ ok: boolean; error?: string; ingressSecret?: string }> {
  await requireAdmin();

  const idCheck = validatePluginId(input.pluginId);
  if (!idCheck.ok) {
    return idCheck;
  }

  try {
    await setPluginGrants(input.pluginId, input.grants);
  } catch (error) {
    if (error instanceof PluginGrantEscalationError) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: describeError(error) };
  }

  await setPluginEnabled(input.pluginId, true);

  let ingressSecret: string | undefined;
  const row = await getPlugin(input.pluginId);
  if (row?.manifest.capabilities.includes("channels:ingress")) {
    ingressSecret = await ensurePluginIngressSecret(input.pluginId);
  }

  const started = await startPluginHost(input.pluginId);
  if (!started.ok) {
    return { ok: false, error: started.error };
  }

  return ingressSecret === undefined
    ? { ok: true }
    : { ok: true, ingressSecret };
}

/** Stops a plugin's host (if running) and marks it disabled. */
export async function disablePluginAction(input: {
  pluginId: string;
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();

  const idCheck = validatePluginId(input.pluginId);
  if (!idCheck.ok) {
    return idCheck;
  }

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
 *
 * Requires an existing row (`getPlugin`) before any filesystem work runs:
 * a destructive `rm(..., { recursive: true, force: true })` must never fire
 * for an id nothing has installed, even a syntactically valid one, and
 * checking here — rather than trusting `pluginDir()`'s own validation alone
 * — means a 404 comes back as an ordinary error value instead of depending
 * on that lower-level throw to save it.
 *
 * No separate ingress-secret cleanup is needed: `removePlugin` deletes the
 * whole row, `ingressSecret` column included, so there is nothing left for
 * a re-installed plugin of the same id to inherit — a fresh install starts
 * with no secret, same as any other plugin that has never been enabled.
 */
export async function removePluginAction(input: {
  pluginId: string;
}): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();

  const idCheck = validatePluginId(input.pluginId);
  if (!idCheck.ok) {
    return idCheck;
  }

  const row = await getPlugin(input.pluginId);
  if (!row) {
    return {
      ok: false,
      error: `No plugin installed with id "${input.pluginId}"`,
    };
  }

  await stopPluginHost(input.pluginId);
  await rm(pluginDir(input.pluginId), { recursive: true, force: true });
  await removePlugin(input.pluginId);

  return { ok: true };
}
