"use server";

import { requireAdmin } from "@/lib/admin/require-admin";
import { getPlugin } from "@/lib/db/plugins";

/**
 * The manifest's declared `net:fetch` domains for one installed plugin.
 *
 * This is what the consent screen must show, verbatim, next to `net:fetch`
 * — read from the manifest `installPluginAction` (`./actions.ts`) already
 * validated and wrote via `upsertPlugin`, never re-derived from anything the
 * client supplies. A separate action rather than an addition to
 * `./actions.ts`: this is a read the consent screen needs right after an
 * install or update, not a mutation, and keeping it apart means a shape
 * change to one file's actions never forces a merge against the other's.
 */
export async function getPluginNetDomainsAction(
  pluginId: string,
): Promise<{ ok: true; netDomains: string[] } | { ok: false; error: string }> {
  await requireAdmin();

  const row = await getPlugin(pluginId);
  if (!row) {
    return { ok: false, error: `No plugin installed with id "${pluginId}"` };
  }

  return { ok: true, netDomains: row.manifest.netDomains ?? [] };
}
