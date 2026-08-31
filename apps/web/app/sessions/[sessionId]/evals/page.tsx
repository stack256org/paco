import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSessionByIdCached } from "@/lib/db/sessions-cache";
import { listEvalHistoryAction, listEvalScenariosAction } from "./actions";
import { EvalsPageContent } from "./evals-page-content";

export const metadata: Metadata = {
  title: "Evals",
  description: "Repo-defined eval scenarios for this session's roster.",
};

interface EvalsPageProps {
  params: Promise<{ sessionId: string }>;
}

export default async function EvalsPage({ params }: EvalsPageProps) {
  const { sessionId } = await params;

  const sessionRecord = await getSessionByIdCached(sessionId);
  if (!sessionRecord) {
    notFound();
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
