import { and, desc, isNotNull } from "drizzle-orm";
import { db } from "./client";
import { sessions } from "./schema";

/**
 * Returns the repo info from the most recently created session that was
 * started from a repository, or null if none exists.
 */
export async function getLastRepo() {
  const row = await db.query.sessions.findFirst({
    where: and(isNotNull(sessions.repoOwner), isNotNull(sessions.repoName)),
    orderBy: [desc(sessions.createdAt)],
    columns: {
      repoOwner: true,
      repoName: true,
    },
  });

  if (!row?.repoOwner || !row?.repoName) return null;

  return {
    owner: row.repoOwner,
    repo: row.repoName,
  };
}
