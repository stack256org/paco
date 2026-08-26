const GITHUB_REPO_PATH_SEGMENT_PATTERN = /^[.\w-]+$/;

export function isValidGitHubRepoOwner(owner: string): boolean {
  return GITHUB_REPO_PATH_SEGMENT_PATTERN.test(owner);
}

export function isValidGitHubRepoName(repoName: string): boolean {
  return GITHUB_REPO_PATH_SEGMENT_PATTERN.test(repoName);
}

export function parseGitHubHttpsUrl(
  repoUrl: string,
): { owner: string; repo: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    return null;
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "github.com" ||
    parsed.username ||
    parsed.password
  ) {
    return null;
  }

  const pathParts = parsed.pathname.replace(/^\/+/, "").split("/");
  const [owner, repoWithSuffix] = pathParts;
  const repo = repoWithSuffix?.replace(/\.git$/, "");
  if (
    pathParts.length !== 2 ||
    !owner ||
    !repo ||
    !isValidGitHubRepoOwner(owner) ||
    !isValidGitHubRepoName(repo)
  ) {
    return null;
  }

  return { owner, repo };
}

export function parseGitHubUrl(
  repoUrl: string,
): { owner: string; repo: string } | null {
  const httpsUrl = parseGitHubHttpsUrl(repoUrl);
  if (httpsUrl) {
    return httpsUrl;
  }

  const sshMatch = repoUrl.match(
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
  );
  if (
    sshMatch?.[1] &&
    sshMatch[2] &&
    isValidGitHubRepoOwner(sshMatch[1]) &&
    isValidGitHubRepoName(sshMatch[2])
  ) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  return null;
}

/**
 * Where to send someone whose GitHub connection needs (re)making.
 *
 * `/settings/connections`, which is where the connection actually lives and
 * where it can be inspected and disconnected as well as made. This used to
 * point at a separate `/get-started` flow that existed only to wrap the same
 * connect button in a numbered checklist; it has been removed, and one
 * screen owning the connection is the point.
 *
 * `next` is preserved so the caller can be returned to whatever it was doing
 * once the connection is made.
 */
export function buildGitHubReconnectUrl(next: string): string {
  const params = new URLSearchParams({ next });
  return `/settings/connections?${params.toString()}`;
}
