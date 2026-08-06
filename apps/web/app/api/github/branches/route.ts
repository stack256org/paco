import { requireAuthenticatedUser } from "@/app/api/chat/_lib/chat-context";
import { getGithubToken } from "@/lib/db/github-tokens";
import { GhError, ghJson, isGhMissing } from "@/lib/github/gh";
import { BAD_REQUEST, GITHUB_NOT_CONNECTED } from "@/lib/error-copy";

const BAD_REPOSITORY =
  "That repository doesn't look right. Pick it from the list again.";

/**
 * Branches in a repository, default branch first.
 *
 * Replaces 329 lines of hand-rolled REST client — two endpoints, three response
 * parsers, and an unauthenticated fallback for public repositories. `gh api`
 * already handles authentication, pagination, and API versioning, and the
 * fallback existed only because an App could be absent; a token cannot be.
 */

export type BranchesResponse = {
  branches: string[];
  defaultBranch: string;
};

/** GitHub's own page ceiling, and more than a picker needs. */
const MAX_LIMIT = 100;

function normalizeLimit(raw: string | null): number {
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return MAX_LIMIT;
  }
  return Math.max(1, Math.min(parsed, MAX_LIMIT));
}

/**
 * GitHub allows almost anything in a repository name except a slash, and a
 * slash is what would let a crafted value reach a different API path.
 */
function isSafeSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

/** Default branch first; the rest alphabetically, since order is otherwise arbitrary. */
function sortBranches(branches: string[], defaultBranch: string): string[] {
  return [...branches].sort((a, b) => {
    if (a === defaultBranch) return -1;
    if (b === defaultBranch) return 1;
    return a.toLowerCase().localeCompare(b.toLowerCase());
  });
}

export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser();
  if (!auth.ok) {
    return auth.response;
  }

  const { searchParams } = new URL(request.url);
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");
  const query = searchParams.get("query")?.trim().toLowerCase();
  const limit = normalizeLimit(searchParams.get("limit"));

  if (!owner || !repo) {
    return Response.json({ error: BAD_REQUEST }, { status: 400 });
  }
  if (!isSafeSegment(owner) || !isSafeSegment(repo)) {
    return Response.json({ error: BAD_REPOSITORY }, { status: 400 });
  }

  const token = await getGithubToken(auth.userId);
  if (!token) {
    return Response.json({ error: GITHUB_NOT_CONNECTED }, { status: 400 });
  }

  try {
    const repoInfo = await ghJson<{ defaultBranchRef?: { name?: unknown } }>(
      ["repo", "view", `${owner}/${repo}`, "--json", "defaultBranchRef"],
      { token },
    );
    const defaultBranch =
      typeof repoInfo.defaultBranchRef?.name === "string"
        ? repoInfo.defaultBranchRef.name
        : "main";

    const refs = await ghJson<Array<{ name?: unknown }>>(
      [
        "api",
        `repos/${owner}/${repo}/branches?per_page=${limit}`,
        "--paginate",
        "--slurp",
      ],
      { token },
    );

    // `--slurp` wraps each page in an array, so pages have to be flattened.
    const names = (Array.isArray(refs) ? refs.flat() : [])
      .map((entry) =>
        entry && typeof entry === "object" && "name" in entry
          ? (entry as { name?: unknown }).name
          : null,
      )
      .filter((name): name is string => typeof name === "string");

    const filtered = query
      ? names.filter((name) => name.toLowerCase().includes(query))
      : names;

    return Response.json({
      branches: sortBranches(filtered, defaultBranch).slice(0, limit),
      defaultBranch,
    } satisfies BranchesResponse);
  } catch (error) {
    if (isGhMissing(error)) {
      return Response.json(
        { error: (error as Error).message },
        { status: 503 },
      );
    }
    if (error instanceof GhError) {
      return Response.json({ error: error.message }, { status: 400 });
    }

    console.error("Failed to list branches:", error);
    return Response.json(
      {
        error:
          "We couldn't load the branches from GitHub. Try again in a moment.",
      },
      { status: 500 },
    );
  }
}
