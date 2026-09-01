import type { Metadata } from "next";
import { HealthPageContent } from "./health-page-content";

export const metadata: Metadata = {
  title: "Instance health",
  description: "Is this Paco instance healthy, and what is it costing you?",
};

/**
 * The one page an operator opens to answer "is this instance healthy, and
 * what is it costing me?"
 *
 * Read-only: nothing on this page mutates state. Reclaiming disk, changing
 * SMTP settings, running a migration all belong to the pages that already
 * own those actions.
 */
export default function HealthPage() {
  return <HealthPageContent />;
}
