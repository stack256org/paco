import type { Metadata } from "next";
import { listPlugins } from "@/lib/db/plugins";
import { toPluginListRow } from "./plugin-list-row";
import { PluginsPageContent } from "./plugins-page-content";

export const metadata: Metadata = {
  title: "Plugins",
  description:
    "Third-party plugins this instance runs, and exactly what each one is allowed to do.",
};

/**
 * Manage installed plugins: what each one asked for, what it was actually
 * granted, and whether it is currently allowed to run.
 *
 * Unlike `AgentsPage`/`SchedulesPage`, the list is fetched here, server-side
 * with `listPlugins()`, rather than by a client-side list action:
 * `PluginsPageContent` reconciles with the server after every mutation via
 * `router.refresh()`, so there is exactly one place — this one — that reads
 * the database's plugin rows, rather than a client fetch that could drift
 * from it.
 */
export default async function PluginsPage() {
  const rows = await listPlugins();
  return <PluginsPageContent initialPlugins={rows.map(toPluginListRow)} />;
}
