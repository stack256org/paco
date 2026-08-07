import type { SandboxHooks } from "../interface.ts";

/** Registry repository the sandbox image is published to by `release.yml`. */
export const SANDBOX_IMAGE_REPO = "ghcr.io/stack256org/paco-sandbox";

/**
 * What to pull when nothing says otherwise — a checkout, rather than a host
 * that installed the `.deb`.
 *
 * `release.yml` builds this image from `./Dockerfile` for amd64 and arm64 and
 * pushes it on every tag. It used to be named `paco-sandbox:latest` here — a
 * bare local name, which Docker resolves against Docker Hub, where it has never
 * existed. So the published image was never fetched by anything, and a host
 * installed from the .deb could not run a single chat: it was told to
 * `docker build` from a repository it does not have.
 */
export const PUBLISHED_SANDBOX_IMAGE = `${SANDBOX_IMAGE_REPO}:latest`;

/**
 * Resolve the image sandboxes are created from.
 *
 * Three sources, most specific first:
 *
 * 1. `PACO_SANDBOX_IMAGE` — a full reference. The escape hatch for an operator
 *    mirroring inside their own network, or a developer running a local build.
 * 2. `PACO_VERSION` — the installed package's version, written into
 *    `/usr/lib/paco/version.env` by `build-deb.sh` and read by the unit. Pins
 *    the image to `:v<version>`.
 * 3. `:latest`.
 *
 * The version pin exists because the image and the app are no longer
 * independent. The container runs as the host's uid so that files it creates on
 * a bind mount are writable by Paco — and that only works on an image built to
 * tolerate an arbitrary uid, with a writable HOME and pnpm store. Pair a new
 * app with an old image and every sandbox fails on an unwritable HOME; pair an
 * old app with a new image and the container is still root. `:latest` cannot
 * express "the one that matches what I just installed", and an upgraded host
 * that already has an old `:latest` locally would never re-pull it.
 *
 * Blank counts as unset throughout: someone who exports a variable and leaves
 * it empty gets the next source down, not a pull of `""` or of `:v`.
 *
 * Still no fallback to a stock Node image when the pull fails. That fallback
 * was worse than an error — sandboxes started fine and then failed at the point
 * of use, because only this image carries the toolchain a generated app needs.
 */
export function resolveSandboxImage(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env.PACO_SANDBOX_IMAGE?.trim();
  if (explicit) {
    return explicit;
  }

  const version = env.PACO_VERSION?.trim();
  if (version) {
    return `${SANDBOX_IMAGE_REPO}:v${version}`;
  }

  return PUBLISHED_SANDBOX_IMAGE;
}

/** Image sandboxes are created from. See {@link resolveSandboxImage}. */
export const SANDBOX_IMAGE = resolveSandboxImage();

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
