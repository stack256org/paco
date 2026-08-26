import type { Metadata } from "next";
import { SchedulesPageContent } from "./schedules-page-content";

export const metadata: Metadata = {
  title: "Schedules",
  description:
    "Cron schedules that fire a task on their own, on their own schedule.",
};

/**
 * Unlike `/settings/agents`, this page is not admin-gated as a whole — every
 * org member may view the organisation's schedules, the same collaborative
 * reasoning `/tasks` uses for the task board. Only creating, editing,
 * deleting, toggling, and "Run now" are admin only, decided inside
 * `SchedulesPageContent` (and enforced again, server-side, by
 * `requireOrgAdmin` in `./actions.ts` regardless of what the client
 * renders).
 */
export default function SchedulesPage() {
  return <SchedulesPageContent />;
}
