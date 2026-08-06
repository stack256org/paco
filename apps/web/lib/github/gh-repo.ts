import "server-only";

import { gh, ghJson } from "./gh";

/**
 * Repository operations, expressed as `gh` invocations.
 *
 * `gh repo create --source --push` does in one call what the GitHub App path
 * needed several for: create the remote, add it as `origin`, and push what is
 * already on disk. That single command is most of why this migration was worth
 * doing — creating a repository from a session used to be disabled outright,
 * returning a 501 that told the user to go and do it on GitHub first.
 *
 * It is not atomic, though. The repository is created first and the push
 * happens after, so a push that fails leaves an empty repository on GitHub
 * with a remote pointing at it. That happened on the first live run, and
 * `createRepoFromLocal` cleans up after itself rather than leaving the user to
 * work out what half-exists.
 */

export type CreatedRepo = {
  owner: string;
  name: string;
  /** `owner/name`, the form `gh` accepts everywhere. */
  nameWithOwner: string;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
};

type RepoView = {
  name?: unknown;
  owner?: { login?: unknown };
  url?: unknown;
  defaultBranchRef?: { name?: unknown } | null;
};

const REPO_TIMEOUT_MS = 180_000;

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`GitHub did not report ${field} for the repository`);
  }
  return value;
}

/** Read a repository's canonical details after creating or locating it. */
async function viewRepo(params: {
  token: string;
  nameWithOwner: string;
}): Promise<CreatedRepo> {
  const view = await ghJson<RepoView>(
    [
      "repo",
      "view",
      params.nameWithOwner,
      "--json",
      "name,owner,url,defaultBranchRef",
    ],
    { token: params.token },
  );

  const name = requireString(view.name, "a name");
  const owner = requireString(view.owner?.login, "an owner");
  const htmlUrl = requireString(view.url, "a URL");

  return {
    owner,
    name,
    nameWithOwner: `${owner}/${name}`,
    htmlUrl,
    cloneUrl: `${htmlUrl}.git`,
    // A repository created from an empty local repo has no default branch ref
    // until something is pushed, so this falls back rather than failing.
    defaultBranch:
      typeof view.defaultBranchRef?.name === "string"
        ? view.defaultBranchRef.name
        : "main",
  };
}

/**
 * Create a GitHub repository from a local one and push it.
 *
 * `owner` is optional: omitted, `gh` creates it under the token's own account,
 * which is what most users want and avoids asking the API which organisations
 * they can write to before they have said they want one.
 *
 * `--push` is deliberate. A repository created empty, with a local one left
 * unpushed beside it, is a state the user has to finish by hand — and the
 * point of the button is that they do not have to.
 */
export async function createRepoFromLocal(params: {
  token: string;
  /** The git repository on disk to publish. */
  cwd: string;
  name: string;
  description?: string;
  isPrivate: boolean;
  owner?: string;
}): Promise<CreatedRepo> {
  const target = params.owner ? `${params.owner}/${params.name}` : params.name;

  const args = [
    "repo",
    "create",
    target,
    params.isPrivate ? "--private" : "--public",
    "--source",
    ".",
    "--remote",
    "origin",
    "--push",
  ];

  if (params.description) {
    args.push("--description", params.description);
  }

  try {
    await gh(args, {
      token: params.token,
      cwd: params.cwd,
      timeoutMs: REPO_TIMEOUT_MS,
    });
  } catch (error) {
    await undoPartialCreate(params, target);
    throw error;
  }

  // `gh repo create` prints the URL but not the owner or default branch, and
  // the owner is only implied when it was left to the token's account.
  return viewRepo({
    token: params.token,
    nameWithOwner: params.owner ? target : await resolveOwn(params),
  });
}

/**
 * Undo as much of a failed create as this token is allowed to.
 *
 * Deleting the repository needs the `delete_repo` scope, which Paco does not
 * ask for — requiring the power to delete repositories in order to create one
 * is a bad trade. So the remote is removed locally, which is what would
 * otherwise make a retry fail with "remote origin already exists", and the
 * original error is re-thrown for the user to read.
 */
async function undoPartialCreate(
  params: { token: string; cwd: string },
  target: string,
): Promise<void> {
  try {
    await gh(["repo", "view", target, "--json", "name"], {
      token: params.token,
      cwd: params.cwd,
    });
  } catch {
    // The repository was never created, so there is nothing to undo.
    return;
  }

  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve) => {
    const child = spawn("git", ["remote", "remove", "origin"], {
      cwd: params.cwd,
      stdio: "ignore",
    });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });

  console.error(
    `[github] Created ${target} but could not push to it. The repository exists and is empty; delete it on GitHub or retry.`,
  );
}

async function resolveOwn(params: {
  token: string;
  name: string;
}): Promise<string> {
  const user = await ghJson<{ login?: unknown }>(["api", "user"], {
    token: params.token,
  });
  return `${requireString(user.login, "an owner")}/${params.name}`;
}

/** Accounts the user can create a repository under: themselves, plus orgs. */
export async function listOwners(token: string): Promise<string[]> {
  const user = await ghJson<{ login?: unknown }>(["api", "user"], { token });
  const owners = [requireString(user.login, "an owner")];

  try {
    const orgs = await ghJson<Array<{ login?: unknown }>>(
      ["api", "user/orgs", "--paginate"],
      { token },
    );
    for (const org of orgs) {
      if (typeof org.login === "string") {
        owners.push(org.login);
      }
    }
  } catch {
    // Organisations need `read:org`; without it the user's own account is
    // still a perfectly good answer.
  }

  return owners;
}
