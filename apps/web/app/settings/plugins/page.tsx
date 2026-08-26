import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isAdmin } from "@/lib/admin/require-admin";
import { listPlugins } from "@/lib/db/plugins";
import { getServerSession } from "@/lib/session/get-server-session";
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
 * Admin-gated like `/settings/agents` and `/settings/health` — `notFound()`
 * rather than a redirect, so a non-admin learns nothing about whether the
 * page exists — even though every mutation underneath (`./actions.ts`)
 * re-checks admin itself regardless of what this page renders.
 *
 * Unlike `AgentsPage`/`SchedulesPage`, the list is fetched here, server-side
 * with `listPlugins()`, rather than by a client-side list action:
 * `PluginsPageContent` reconciles with the server after every mutation via
 * `router.refresh()`, so there is exactly one place — this one — that reads
 * the database's plugin rows, rather than a client fetch that could drift
 * from it.
 */
export default async function PluginsPage() {
  const session = await getServerSession();

  if (!session?.user?.id || !(await isAdmin(session.user.id))) {
    notFound();
  }

  const rows = await listPlugins();
  return <PluginsPageContent initialPlugins={rows.map(toPluginListRow)} />;
}
