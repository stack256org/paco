import { repoDir } from "@paco/sandbox";
import { z } from "zod";
import { requireAuthenticatedUser } from "@/app/api/chat/_lib/chat-context";
import { hostWorkspaceFor } from "@/lib/agent/workspace-paths";
import { getGithubToken } from "@/lib/db/github-tokens";
import { getSessionById, updateSession } from "@/lib/db/sessions";
import { GhError, isGhMissing } from "@/lib/github/gh";
import { createRepoFromLocal } from "@/lib/github/gh-repo";
import { GITHUB_NOT_CONNECTED, SESSION_NOT_FOUND } from "@/lib/error-copy";

/** Pushing an existing project can take a while on a slow connection. */
export const maxDuration = 300;

/**
 * GitHub's own rule for repository names, applied here so a bad one is
 * rejected before a round trip rather than after one.
 */
const repoNameSchema = z
  .string()
  .trim()
  .min(1, "Repository name is required")
  .max(100, "Repository name is too long")
  .regex(
    /^[A-Za-z0-9._-]+$/,
    "Use only letters, numbers, hyphens, underscores, and dots",
  );

const createRepoSchema = z.object({
  sessionId: z.string().min(1),
  repoName: repoNameSchema,
  description: z.string().trim().max(350).optional(),
  isPrivate: z.boolean().default(true),
  owner: z.string().trim().min(1).optional(),
});

export async function POST(request: Request) {
  const auth = await requireAuthenticatedUser();
  if (!auth.ok) {
    return auth.response;
  }

  const parsed = createRepoSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  const { sessionId, repoName, description, isPrivate, owner } = parsed.data;

  const token = await getGithubToken(auth.userId);
  if (!token) {
    return Response.json({ error: GITHUB_NOT_CONNECTED }, { status: 400 });
  }

  const session = await getSessionById(sessionId);
  if (!session || session.userId !== auth.userId) {
    return Response.json({ error: SESSION_NOT_FOUND }, { status: 404 });
  }
  if (!session.sandboxState) {
    return Response.json(
      {
        error: "Your workspace isn't ready yet. Wait a moment, then try again.",
      },
      { status: 409 },
    );
  }

  // The session's repository, not a chat's worktree: publishing a session
  // means publishing its default branch, and a worktree has only one chat's
  // branch checked out.
  const cwd = repoDir(hostWorkspaceFor(session.sandboxState));

  try {
    const repo = await createRepoFromLocal({
      token,
      cwd,
      name: repoName,
      isPrivate,
      ...(description ? { description } : {}),
      ...(owner ? { owner } : {}),
    });

    // Recorded so the session knows where it now lives. Without this the
    // sidebar keeps grouping it under "Workspaces" and a later push has no
    // remote to target.
    await updateSession(sessionId, {
      repoOwner: repo.owner,
      repoName: repo.name,
      cloneUrl: repo.cloneUrl,
    });

    return Response.json({
      repoUrl: repo.htmlUrl,
      owner: repo.owner,
      repoName: repo.name,
      cloneUrl: repo.cloneUrl,
      branch: repo.defaultBranch,
    });
  } catch (error) {
    if (isGhMissing(error)) {
      return Response.json(
        { error: (error as Error).message },
        { status: 503 },
      );
    }
    if (error instanceof GhError) {
      // `gh` already says the useful thing — "Name already exists on this
      // account", "insufficient permission" — so it is passed through rather
      // than replaced with something vaguer.
      return Response.json({ error: error.message }, { status: 400 });
    }

    console.error("Failed to create repository:", error);
    return Response.json(
      {
        error:
          "We couldn't create that repository on GitHub. Try again in a moment.",
      },
      { status: 500 },
    );
  }
}
