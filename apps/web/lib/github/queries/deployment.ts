"use server";

import { getSessionById } from "@/lib/db/sessions";
import { findDeploymentUrl } from "@/lib/github/deployments";
import { getGithubToken } from "@/lib/db/github-tokens";
import { getServerSession } from "@/lib/session/get-server-session";
import { NOT_YOURS, SESSION_NOT_FOUND, SIGNED_OUT } from "@/lib/error-copy";

// ---- types ----

export type PrDeploymentResponse = {
  deploymentUrl: string | null;
  buildingDeploymentUrl?: string | null;
  failedDeploymentUrl?: string | null;
};

// ---- helpers ----

async function requireAuth() {
  const session = await getServerSession();
  if (!session?.user) {
    throw new Error(SIGNED_OUT);
  }
  return session;
}

async function requireOwnedSession(userId: string, sessionId: string) {
  const sessionRecord = await getSessionById(sessionId);
  if (!sessionRecord) {
    throw new Error(SESSION_NOT_FOUND);
  }
  if (sessionRecord.userId !== userId) {
    throw new Error(NOT_YOURS);
  }
  return sessionRecord;
}

// ---- server action ----

export async function getDeploymentUrl(params: {
  sessionId: string;
  prNumber?: number;
  branch?: string;
}): Promise<PrDeploymentResponse> {
  const { sessionId, prNumber } = params;

  const session = await requireAuth();
  const sessionRecord = await requireOwnedSession(session.user.id, sessionId);

  // validate prNumber if provided
  if (prNumber !== undefined && (Number.isNaN(prNumber) || prNumber <= 0)) {
    return { deploymentUrl: null };
  }

  if (
    prNumber !== undefined &&
    sessionRecord.prNumber !== null &&
    prNumber !== sessionRecord.prNumber
  ) {
    return { deploymentUrl: null };
  }

  // Preview URLs come from GitHub deployment statuses on the PR head commit.
  if (
    !sessionRecord.repoOwner ||
    !sessionRecord.repoName ||
    sessionRecord.prNumber === null
  ) {
    return { deploymentUrl: null };
  }

  const token = await getGithubToken(session.user.id);
  if (!token) {
    return { deploymentUrl: null };
  }

  const deploymentResult = await findDeploymentUrl({
    owner: sessionRecord.repoOwner,
    repo: sessionRecord.repoName,
    prNumber: sessionRecord.prNumber,
    token,
  });

  if (!deploymentResult.success) {
    return { deploymentUrl: null };
  }

  return {
    deploymentUrl: deploymentResult.deploymentUrl,
    buildingDeploymentUrl: deploymentResult.buildingDeploymentUrl,
    failedDeploymentUrl: deploymentResult.failedDeploymentUrl,
  };
}
