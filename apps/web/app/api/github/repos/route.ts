import { requireAuthenticatedUser } from "@/app/api/chat/_lib/chat-context";
import { getGithubToken } from "@/lib/db/github-tokens";
import { GhError, ghJson, isGhMissing } from "@/lib/github/gh";

/**
 * Repositories the connected account can push to.
 *
 * Replaces the App's installation-scoped listing. An App could only ever see
 * repositories it had been installed on, which is why the old UI had to explain
 * installations at all — a user's own repository would simply be missing from
 * the list until they went and installed something. A token sees everything the
 * person can see.
 */

export type GithubRepoSummary = {
  nameWithOwner: string;
  name: string;
  owner: string;
  isPrivate: boolean;
  defaultBranch: string;
  updatedAt: string | null;
  description: string | null;
};

/** One page is plenty for a picker with a search box. */
const LIMIT = 100;

type RepoListEntry = {
  name?: unknown;
  nameWithOwner?: unknown;
  owner?: { login?: unknown };
  isPrivate?: unknown;
  defaultBranchRef?: { name?: unknown } | null;
  updatedAt?: unknown;
  description?: unknown;
};

function toSummary(entry: RepoListEntry): GithubRepoSummary | null {
  if (
    typeof entry.nameWithOwner !== "string" ||
    typeof entry.name !== "string"
  ) {
    return null;
  }

  const [owner] = entry.nameWithOwner.split("/");

  return {
    nameWithOwner: entry.nameWithOwner,
    name: entry.name,
    owner:
      typeof entry.owner?.login === "string"
        ? entry.owner.login
        : (owner ?? ""),
    isPrivate: entry.isPrivate === true,
    defaultBranch:
      typeof entry.defaultBranchRef?.name === "string"
        ? entry.defaultBranchRef.name
        : "main",
    updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : null,
    description:
      typeof entry.description === "string" && entry.description.length > 0
        ? entry.description
        : null,
  };
}

export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser();
  if (!auth.ok) {
    return auth.response;
  }

  const token = await getGithubToken(auth.userId);
  if (!token) {
    return Response.json(
      { error: "Connect GitHub in Settings first.", repos: [] },
      { status: 400 },
    );
  }

  const query = new URL(request.url).searchParams.get("q")?.trim();

  const args = [
    "repo",
    "list",
    "--limit",
    String(LIMIT),
    "--json",
    "name,nameWithOwner,owner,isPrivate,defaultBranchRef,updatedAt,description",
  ];

  // `gh repo list` has no search flag, so filtering happens after the fetch.
  // With one page that is cheap, and it keeps the shape of the response the
  // same whether or not a query was given.
  try {
    const entries = await ghJson<RepoListEntry[]>(args, { token });
    let repos = entries
      .map(toSummary)
      .filter((repo): repo is GithubRepoSummary => repo !== null);

    if (query) {
      const needle = query.toLowerCase();
      repos = repos.filter((repo) =>
        repo.nameWithOwner.toLowerCase().includes(needle),
      );
    }

    return Response.json({ repos });
  } catch (error) {
    if (isGhMissing(error)) {
      return Response.json(
        { error: (error as Error).message, repos: [] },
        { status: 503 },
      );
    }
    if (error instanceof GhError) {
      return Response.json(
        { error: error.message, repos: [] },
        { status: 400 },
      );
    }

    console.error("Failed to list repositories:", error);
    return Response.json(
      {
        error:
          "We couldn't load your repositories from GitHub. Try again in a moment.",
        repos: [],
      },
      { status: 500 },
    );
  }
}
