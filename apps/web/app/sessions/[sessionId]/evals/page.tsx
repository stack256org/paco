import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getSessionByIdCached } from "@/lib/db/sessions-cache";
import { getMemberRole } from "@/lib/org/membership";
import { getServerSession } from "@/lib/session/get-server-session";
import { listEvalHistoryAction, listEvalScenariosAction } from "./actions";
import { EvalsPageContent } from "./evals-page-content";

export const metadata: Metadata = {
  title: "Evals",
  description: "Repo-defined eval scenarios for this session's roster.",
};

interface EvalsPageProps {
  params: Promise<{ sessionId: string }>;
}

/**
 * Auth follows the same shape every `/sessions/[sessionId]` page uses
 * (`layout.tsx`, `chats/[chatId]/page.tsx`): sign-in, session ownership,
 * `notFound()` for a session that doesn't exist. Organisation membership is
 * checked on top of that — evals write rows scoped to the organisation, not
 * just this session — the same gate `./actions.ts` re-applies on every
 * mutation regardless of what this page already checked.
 */
export default async function EvalsPage({ params }: EvalsPageProps) {
  const { sessionId } = await params;

  const session = await getServerSession();
  if (!session?.user) {
    redirect("/");
  }

  const sessionRecord = await getSessionByIdCached(sessionId);
  if (!sessionRecord) {
    notFound();
  }
  if (sessionRecord.userId !== session.user.id) {
    redirect("/");
  }
  if (!(await getMemberRole(session.user.id))) {
    redirect("/");
  }

  const [discovery, history] = await Promise.all([
    listEvalScenariosAction(sessionId),
    listEvalHistoryAction(sessionId),
  ]);

  return (
    <EvalsPageContent
      initialDiscoveryErrors={discovery.errors}
      initialHistory={history}
      initialScenarios={discovery.scenarios}
      sessionId={sessionId}
    />
  );
}
