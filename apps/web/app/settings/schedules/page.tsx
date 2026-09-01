import type { Metadata } from "next";
import { SchedulesPageContent } from "./schedules-page-content";

export const metadata: Metadata = {
  title: "Schedules",
  description:
    "Cron schedules that fire a task on their own, on their own schedule.",
};

/**
 * Shows the organisation's schedules along with full create, edit, delete,
 * toggle, and "Run now" controls — the instance has exactly one tenant, so
 * there is no separate admin-only gate for those actions any more.
 */
export default function SchedulesPage() {
  return <SchedulesPageContent />;
}
