import "server-only";

import { eq } from "drizzle-orm";
import { open, seal } from "@/lib/crypto/secret-box";
import { db } from "./client";
import { githubTokens } from "./schema";

/**
 * What the UI is allowed to know about a stored credential.
 *
 * Deliberately does not carry the token. Every route that returns connection
 * state to the browser returns this shape, so there is no path by which the
 * secret reaches the client through carelessness rather than intent.
 */
export type GithubConnection = {
  login: string;
  githubUserId: number | null;
  scopes: string[];
  connectedAt: Date;
};

export async function getGithubConnection(
  userId: string,
): Promise<GithubConnection | null> {
  const row = await db.query.githubTokens.findFirst({
    where: eq(githubTokens.userId, userId),
  });

  if (!row) {
    return null;
  }

  return {
    login: row.login,
    githubUserId: row.githubUserId,
    scopes: row.scopes,
    connectedAt: row.createdAt,
  };
}

/**
 * The user's GitHub token, ready to hand to `gh`.
 *
 * Returns `null` both when there is no credential and when the stored one
 * cannot be decrypted — which happens if `APP_SECRET` changed. Either way the
 * only useful outcome is asking the user to connect again, so the caller does
 * not have to tell the two apart.
 */
export async function getGithubToken(userId: string): Promise<string | null> {
  const row = await db.query.githubTokens.findFirst({
    where: eq(githubTokens.userId, userId),
  });

  if (!row) {
    return null;
  }

  try {
    return open(row.sealedToken);
  } catch {
    console.error(
      `[github] Stored token for user ${userId} could not be decrypted; it was probably sealed under a different APP_SECRET.`,
    );
    return null;
  }
}

/** Store (or replace) a user's token. The value is sealed before it is written. */
export async function saveGithubToken(params: {
  userId: string;
  token: string;
  login: string;
  githubUserId: number | null;
  scopes: string[];
}): Promise<void> {
  const sealedToken = seal(params.token);

  await db
    .insert(githubTokens)
    .values({
      userId: params.userId,
      sealedToken,
      login: params.login,
      githubUserId: params.githubUserId,
      scopes: params.scopes,
    })
    .onConflictDoUpdate({
      target: githubTokens.userId,
      set: {
        sealedToken,
        login: params.login,
        githubUserId: params.githubUserId,
        scopes: params.scopes,
        updatedAt: new Date(),
      },
    });
}

export async function deleteGithubToken(userId: string): Promise<void> {
  await db.delete(githubTokens).where(eq(githubTokens.userId, userId));
}
