import type { Capability } from "@paco/plugin-kit";
import type { PluginRow } from "@/lib/db/schema";

/**
 * The plain, client-safe slice of an installed plugin's row.
 *
 * `page.tsx` fetches full `PluginRow`s with `listPlugins()` — a Server
 * Component, so importing `@/lib/db/plugins` (`server-only`) directly is
 * fine there — and maps each one through this before handing it to
 * `PluginsPageContent`. The row's `manifest` and `contentHash` never need to
 * cross into client code: the manifest's `net:fetch` domain list is read
 * fresh, per plugin, via `getPluginConsentDetailsAction` at consent time rather
 * than carried around here where it could go stale between a page load and
 * a later grant.
 */
export interface PluginListRow {
  id: string;
  source: string;
  version: string;
  enabled: boolean;
  grantedCapabilities: Capability[];
}

export function toPluginListRow(row: PluginRow): PluginListRow {
  return {
    id: row.id,
    source: row.source,
    version: row.version,
    enabled: row.enabled,
    grantedCapabilities: row.grantedCapabilities,
  };
}
