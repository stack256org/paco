export interface RepoBranchesResponse {
  branches: string[];
  defaultBranch: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function fetchRepoBranches(
  owner: string,
  repo: string,
): Promise<RepoBranchesResponse> {
  const response = await fetch(
    `/api/github/branches?owner=${owner}&repo=${repo}`,
  );
  if (!response.ok) {
    throw new Error(
      "We couldn't load the branches from GitHub. Try again in a moment.",
    );
  }

  const data: unknown = await response.json();
  if (!isRecord(data)) {
    throw new Error(
      "We couldn't read the branches GitHub sent back. Try again in a moment.",
    );
  }

  const branches = Array.isArray(data.branches)
    ? data.branches.filter(
        (branch): branch is string => typeof branch === "string",
      )
    : [];
  const defaultBranch =
    typeof data.defaultBranch === "string" ? data.defaultBranch : "main";

  return { branches, defaultBranch };
}
