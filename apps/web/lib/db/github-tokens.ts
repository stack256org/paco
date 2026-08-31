import "server-only";

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

/**
 * The instance's stored connection, unfiltered.
 *
 * There is exactly one tenant, so at most one row exists — no `userId` is
 * needed to find it.
 */
export async function getGithubConnection(): Promise<GithubConnection | null> {
  const row = await db.query.githubTokens.findFirst();

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
 * The instance's GitHub token, ready to hand to `gh`.
 *
 * Returns `null` both when there is no credential and when the stored one
 * cannot be decrypted — which happens if `APP_SECRET` changed. Either way the
 * only useful outcome is asking to connect again, so the caller does not
 * have to tell the two apart. Unfiltered read, same reasoning as
 * `getGithubConnection`.
 */
export async function getGithubToken(): Promise<string | null> {
  const row = await db.query.githubTokens.findFirst();

  if (!row) {
    return null;
  }

  try {
    return open(row.sealedToken);
  } catch {
    console.error(
      "[github] Stored token could not be decrypted; it was probably sealed under a different APP_SECRET.",
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

/**
 * Removes the instance's stored connection.
 *
 * Unconditional delete: there is at most one row, so there is nothing to
 * filter by — deleting all of `githubTokens` is deleting the one credential
 * this instance ever had.
 */
export async function deleteGithubToken(): Promise<void> {
  await db.delete(githubTokens);
}
