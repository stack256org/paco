import { chatBranchName } from "@paco/sandbox";
import { z } from "zod";
import { requireOwnedChatById } from "@/app/api/chat/_lib/chat-context";
import { hostChatWorktree } from "@/lib/agent/workspace-paths";
import { getGithubToken } from "@/lib/db/github-tokens";
import { getSessionById, updateSession } from "@/lib/db/sessions";
import { GhError, isGhMissing } from "@/lib/github/gh";
import {
  createPullRequest,
  findPullRequest,
  type PullRequestSummary,
} from "@/lib/github/gh-pr";
import { GITHUB_NOT_CONNECTED, SESSION_NOT_FOUND } from "@/lib/error-copy";

/** Pushing a branch on a slow connection, then opening the PR. */
export const maxDuration = 300;

type RouteContext = {
  params: Promise<{ sessionId: string; chatId: string }>;
};

const openSchema = z.object({
  title: z.string().trim().min(1, "A pull request needs a title").max(256),
  body: z.string().max(60_000).optional(),
  /** Defaults to the repository's own default branch. */
  base: z.string().trim().min(1).optional(),
  draft: z.boolean().default(false),
});

export type ChatPullRequestResponse = {
  pullRequest: PullRequestSummary | null;
};

/**
 * The pull request for one chat.
 *
 * Per chat, not per session: each chat works on `chat/<chatId>` in its own
 * worktree, so a session-wide pull request would either span several branches
 * or silently pick one of them.
 */
async function resolveContext(context: RouteContext) {
  const { sessionId, chatId } = await context.params;

  const chatContext = await requireOwnedChatById({ chatId });
  if (!chatContext.ok) {
    return { ok: false as const, response: chatContext.response };
  }

  const session = await getSessionById(sessionId);
  if (!session) {
    return {
      ok: false as const,
      response: Response.json({ error: SESSION_NOT_FOUND }, { status: 404 }),
    };
  }
  if (!session.sandboxState) {
    return {
      ok: false as const,
      response: Response.json(
        {
          error:
            "Your workspace isn't ready yet. Wait a moment, then try again.",
        },
        { status: 409 },
      ),
    };
  }
  if (!session.repoName) {
    return {
      ok: false as const,
      response: Response.json(
        {
          error:
            "This workspace has no GitHub repository yet. Create one first.",
        },
        { status: 409 },
      ),
    };
  }

  const token = await getGithubToken();
  if (!token) {
    return {
      ok: false as const,
      response: Response.json({ error: GITHUB_NOT_CONNECTED }, { status: 400 }),
    };
  }

  return {
    ok: true as const,
    sessionId,
    chatId,
    token,
    // The chat's worktree: `gh` reads the repository from its working
    // directory, and this is the only directory with the chat's branch checked
    // out.
    cwd: hostChatWorktree(session.sandboxState, chatId),
    branch: chatBranchName(chatId),
    defaultBranch: session.branch ?? "main",
  };
}

function toErrorResponse(error: unknown): Response {
  if (isGhMissing(error)) {
    return Response.json({ error: (error as Error).message }, { status: 503 });
  }
  if (error instanceof GhError) {
    // `gh` says the useful thing: "No commits between main and chat/…",
    // "must be a collaborator", "a pull request already exists".
    return Response.json({ error: error.message }, { status: 400 });
  }

  console.error("Pull request operation failed:", error);
  return Response.json(
    { error: "We couldn't finish that on GitHub. Try again in a moment." },
    { status: 500 },
  );
}

export async function GET(_request: Request, context: RouteContext) {
  const resolved = await resolveContext(context);
  if (!resolved.ok) {
    return resolved.response;
  }

  try {
    const pullRequest = await findPullRequest({
      token: resolved.token,
      cwd: resolved.cwd,
      branch: resolved.branch,
    });

    return Response.json({ pullRequest } satisfies ChatPullRequestResponse);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const parsed = openSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  const resolved = await resolveContext(context);
  if (!resolved.ok) {
    return resolved.response;
  }

  try {
    const pullRequest = await createPullRequest({
      token: resolved.token,
      cwd: resolved.cwd,
      base: parsed.data.base ?? resolved.defaultBranch,
      head: resolved.branch,
      title: parsed.data.title,
      ...(parsed.data.body ? { body: parsed.data.body } : {}),
      draft: parsed.data.draft,
    });

    // Mirrored onto the session so the sidebar can show the PR badge without
    // asking GitHub on every render.
    await updateSession(resolved.sessionId, {
      prNumber: pullRequest.number,
      prStatus: pullRequest.state,
    });

    return Response.json({ pullRequest } satisfies ChatPullRequestResponse);
  } catch (error) {
    return toErrorResponse(error);
  }
}
