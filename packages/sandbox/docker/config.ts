import type { SandboxHooks } from "../interface.ts";

/**
 * Image sandboxes are created from.
 *
 * Built from `./Dockerfile`:
 *
 *   docker build -t paco-sandbox:latest packages/sandbox/docker
 *
 * Not configurable, and deliberately not falling back to a stock Node image.
 * The fallback was worse than an error: sandboxes started fine and then failed
 * at the point of use, because only this image carries the toolchain a
 * generated app needs. One image means the sandbox either works or the image
 * is missing, and the second is a clear failure at startup.
 */
export const SANDBOX_IMAGE = "paco-sandbox:latest";

/** Ports published from the container to the host for preview URLs. */
export const DEFAULT_PORTS = [3000, 5173, 4321, 8000] as const;

/** Directory inside the container where the workspace is mounted. */
export const CONTAINER_WORKDIR = "/workspace";

/**
 * Git identity used when the caller supplies none.
 *
 * Not cosmetic: git refuses to commit without an identity, and Paco commits on
 * the agent's behalf — the initial commit a worktree branches from, and any
 * commit the agent makes itself. A sandbox that cannot commit cannot host a
 * chat, so there is always an identity, and a caller-supplied one overrides it.
 */
export const DEFAULT_GIT_USER = {
  name: "Paco",
  email: "agent@paco.local",
} as const;

/**
 * Fill in whichever half of a git identity is missing.
 *
 * Each field is checked on its own, and blank counts as missing. A GitHub
 * account with no display name yields `{ name: "", email: "…" }`, which is not
 * absent — so `?? DEFAULT_GIT_USER` passed it straight through and every commit
 * failed with "empty ident name". Since the initial commit is what a chat's
 * worktree branches from, that made the whole app unusable for anyone whose
 * profile has no name set.
 */
export function resolveGitUser(gitUser?: { name?: string; email?: string }): {
  name: string;
  email: string;
} {
  return {
    name: gitUser?.name?.trim() || DEFAULT_GIT_USER.name,
    email: gitUser?.email?.trim() || DEFAULT_GIT_USER.email,
  };
}

/** Default idle timeout before a sandbox is proactively stopped (30 min). */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** Prefix applied to every container this project creates. */
export const CONTAINER_NAME_PREFIX = "paco-sbx-";

export interface DockerSandboxConfig {
  /**
   * Stable sandbox name. Maps to both the host workspace directory and the
   * container name, which is what makes reconnect/resume work across restarts.
   */
  name: string;
  /** Host directory that backs the workspace. Created if missing. */
  hostWorkspace: string;
  /** Container image. Defaults to {@link SANDBOX_IMAGE}. */
  image?: string;
  /** Environment variables exported inside the container. */
  env?: Record<string, string>;
  /** Git identity used for commits made inside the workspace. */
  gitUser?: { name: string; email: string };
  /** Lifecycle hooks. */
  hooks?: SandboxHooks;
  /** Idle timeout in milliseconds. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeout?: number;
  /** Ports to publish. Defaults to {@link DEFAULT_PORTS}. */
  ports?: number[];
  /** CPU limit expressed in whole cores. Omit for unlimited. */
  cpus?: number;
  /** Memory limit in bytes. Omit for unlimited. */
  memoryBytes?: number;
  /**
   * When true the container is created with no network access. Useful for
   * running untrusted generated code.
   */
  networkDisabled?: boolean;
  /** Skip `git init` when preparing an empty workspace. */
  skipGitWorkspaceBootstrap?: boolean;
  /**
   * Extra labels merged over the container's own `paco.sandbox` labels.
   *
   * This is how a chat's Traefik routing (built by `previewLabels`, see
   * `apps/web/lib/preview/labels.ts`) reaches the container — this module
   * never needs to know Traefik exists. Caller labels win on key collision.
   */
  labels?: Record<string, string>;
  /**
   * Name of a Docker network to attach the container to, in addition to
   * Docker's default bridge network. Created on demand if it does not
   * already exist (see `ensureNetworkExists` in `provisioning.ts`) — a
   * sandbox created outside `docker compose`'s own lifecycle cannot rely on
   * compose having created it first.
   *
   * Traefik and a sandbox's own container are otherwise on unrelated
   * networks — Traefik's Docker provider can resolve the labels above into a
   * router, but routing a request there needs a network path to the
   * container, which only exists once both sides share a network name.
   *
   * A side effect worth knowing about: every container on a shared
   * user-defined network gets Docker's embedded DNS, so sandboxes that join
   * the same named network can resolve and reach each other by container
   * name — unlike Docker's default bridge network, which has no such
   * discovery. Traefik relies on exactly this to reach `paco` and each
   * sandbox by name; an operator should not be surprised that two sandboxes
   * sharing this network can also see one another.
   */
  network?: string;
}

/**
 * Resolve the Docker container name for a sandbox name.
 *
 * Docker only permits `[a-zA-Z0-9][a-zA-Z0-9_.-]*`, so anything else is
 * replaced rather than rejected — callers pass session ids and repo names.
 */
export function toContainerName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_.-]/g, "-");
  return `${CONTAINER_NAME_PREFIX}${sanitized}`;
}
