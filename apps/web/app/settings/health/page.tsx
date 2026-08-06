import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isAdmin } from "@/lib/admin/require-admin";
import { getServerSession } from "@/lib/session/get-server-session";
import { HealthPageContent } from "./health-page-content";

export const metadata: Metadata = {
  title: "Instance health",
  description: "Is this Paco instance healthy, and what is it costing you?",
};

/**
 * The one page an operator opens to answer "is this instance healthy, and
 * what is it costing me?"
 *
 * Server-gated the same way `/settings/users` is — `notFound()` rather than a
 * redirect, so a non-admin learns nothing about whether the page exists —
 * even though every metric underneath is fetched client-side and re-checks
 * admin itself (`requireAdmin` in `lib/admin/health-actions.ts`). Read-only:
 * nothing on this page mutates state. Reclaiming disk, changing SMTP
 * settings, running a migration all belong to the pages that already own
 * those actions.
 */
export default async function HealthPage() {
  const session = await getServerSession();

  if (!session?.user?.id || !(await isAdmin(session.user.id))) {
    notFound();
  }

  return <HealthPageContent />;
}
