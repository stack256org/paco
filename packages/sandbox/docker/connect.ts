import * as os from "node:os";
import * as path from "node:path";
import type { Sandbox, SandboxHooks } from "../interface.ts";
import { CONTAINER_WORKDIR, type DockerSandboxConfig } from "./config.ts";
import { REPO_DIRNAME, repoDir } from "./layout.ts";
import { DockerSandbox } from "./sandbox.ts";
import type { DockerState } from "./state.ts";

export interface DockerConnectOptions {
  env?: Record<string, string>;
  githubToken?: string;
  gitUser?: { name: string; email: string };
  hooks?: SandboxHooks;
  timeout?: number;
  ports?: number[];
  cpus?: number;
  memoryBytes?: number;
  image?: string;
  networkDisabled?: boolean;
  skipGitWorkspaceBootstrap?: boolean;
  labels?: Record<string, string>;
  network?: string;
}

/**
 * Root directory holding every sandbox workspace on the host.
 *
 * Override with `PACO_WORKSPACE_ROOT` when the default home-relative location
 * is not writable (containerized deployments, CI).
 */
export function workspaceRoot(): string {
  return (
    process.env.PACO_WORKSPACE_ROOT ??
    // `turbopackIgnore` tells Next's build-time file tracer not to follow this
    // call: `os.homedir()` is a value it cannot resolve statically, and
    // without the hint it decides the whole module's trace is untrustworthy
    // and falls back to tracing the entire project — which is how
    // `next.config.ts` itself ended up "traced" as a runtime dependency, and
    // how `.next/standalone` ended up missing `drizzle-orm`, `postgres`, and
    // even `@swc/helpers` (verified by running the standalone output in
    // isolation — see packaging/build-deb.sh comments). This branch is only
    // ever reached without `PACO_WORKSPACE_ROOT` set, which every packaged
    // deployment (Docker, the native `.deb`) sets explicitly.
    path.join(/* turbopackIgnore: true */ os.homedir(), ".paco", "workspaces")
  );
}

function resolveHostWorkspace(state: DockerState, name: string): string {
  return state.hostWorkspace
    ? path.resolve(state.hostWorkspace)
    : path.join(workspaceRoot(), name);
}

/**
 * Clone the configured source into the workspace's `repo/` directory.
 *
 * `repo/` rather than the workspace root because each chat gets a worktree of
 * this repository under `chats/`, and git can only resolve a worktree from its
 * parent repository — so the two must be siblings inside the one bind mount.
 *
 * No-ops when `repo/` already contains a git repository, so reconnecting to an
 * existing sandbox never clobbers in-progress work.
 */
async function prepareSource(
  sandbox: DockerSandbox,
  state: DockerState,
  githubToken?: string,
): Promise<void> {
  const source = state.source;
  if (!source) {
    return;
  }

  const repo = repoDir(sandbox.hostWorkspace);

  const existing = await sandbox.exec("git rev-parse --git-dir", repo, 10_000);
  if (existing.success) {
    return;
  }

  // The token is scoped to this clone and cleared immediately after, so it
  // never lands in the persisted remote URL.
  if (githubToken) {
    await sandbox.setGitHubAuthToken(githubToken);
  }

  try {
    const branch = source.branch
      ? `--branch ${JSON.stringify(source.branch)}`
      : "";
    const url = githubToken
      ? source.repo.replace(
          "https://",
          `https://x-access-token:${githubToken}@`,
        )
      : source.repo;

    const clone = await sandbox.exec(
      `git clone ${branch} ${JSON.stringify(url)} ${REPO_DIRNAME}`,
      CONTAINER_WORKDIR,
      300_000,
    );

    if (!clone.success) {
      throw new Error(`Failed to clone ${source.repo}: ${clone.stderr}`);
    }

    // Reset the remote so no credential is persisted in .git/config.
    await sandbox.exec(
      `git remote set-url origin ${JSON.stringify(source.repo)}`,
      repo,
      10_000,
    );

    if (source.newBranch) {
      await sandbox.exec(
        `git checkout -b ${JSON.stringify(source.newBranch)}`,
        repo,
        30_000,
      );
    }
  } finally {
    if (githubToken) {
      await sandbox.setGitHubAuthToken(undefined);
    }
  }
}

/**
 * Connect to a Docker-backed sandbox.
 *
 * Name-based and idempotent: the same `sandboxName` always resolves to the same
 * host workspace and container, so this doubles as both "create" and "resume".
 */
export async function connectDocker(
  state: DockerState,
  options?: DockerConnectOptions,
): Promise<Sandbox> {
  const name =
    state.sandboxName ?? `sbx-${Math.random().toString(36).slice(2, 10)}`;

  const config: DockerSandboxConfig = {
    name,
    hostWorkspace: resolveHostWorkspace(state, name),
    env: options?.env,
    gitUser: options?.gitUser,
    hooks: options?.hooks,
    ...(options?.timeout !== undefined && { timeout: options.timeout }),
    ...(options?.ports && { ports: options.ports }),
    ...(options?.cpus !== undefined && { cpus: options.cpus }),
    ...(options?.memoryBytes !== undefined && {
      memoryBytes: options.memoryBytes,
    }),
    ...(options?.image && { image: options.image }),
    ...(options?.networkDisabled !== undefined && {
      networkDisabled: options.networkDisabled,
    }),
    ...(options?.skipGitWorkspaceBootstrap && {
      skipGitWorkspaceBootstrap: true,
    }),
    ...(options?.labels && { labels: options.labels }),
    ...(options?.network && { network: options.network }),
  };

  const sandbox = await DockerSandbox.create(config);
  await prepareSource(sandbox, state, options?.githubToken);
  return sandbox;
}
