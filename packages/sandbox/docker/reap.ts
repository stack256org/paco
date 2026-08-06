import Docker from "dockerode";
import { CONTAINER_NAME_PREFIX } from "./config.ts";

/**
 * Finding and removing the containers Paco created — and only those.
 *
 * Nothing else on the machine is Paco's to touch. A self-hosted install shares
 * a Docker daemon with everything else the operator runs, and on the machine
 * this was written for that included `paco-pg`, the Postgres holding the whole
 * product's data. A prefix match on "paco" would have removed it. So the guard
 * here is the *full* container prefix, `paco-sbx-`, checked twice: once when
 * listing, and again inside the removal call, which resolves the name against
 * that same listing rather than trusting its caller.
 */

/** A `paco-sbx-*` container as Docker currently reports it. */
export interface SandboxContainerInfo {
  id: string;
  /** Container name without Docker's leading slash, e.g. `paco-sbx-session_x`. */
  name: string;
  /** Docker's own state word: `running`, `exited`, `created`, `paused`, … */
  state: string;
  running: boolean;
  /** Seconds since the epoch, as Docker reports it. */
  createdAtSeconds: number;
  /**
   * Bytes in the container's writable layer.
   *
   * This is the disk a container costs *beyond* its image, which is the honest
   * number to show: the image is shared by every sandbox and does not go away
   * when one container does.
   */
  writableBytes: number;
}

/** Whether a container name is one of Paco's sandboxes. */
export function isSandboxContainerName(name: string): boolean {
  return (
    name.startsWith(CONTAINER_NAME_PREFIX) &&
    name.length > CONTAINER_NAME_PREFIX.length
  );
}

/** Strip the leading slash Docker puts on container names. */
export function normalizeContainerName(name: string): string {
  return name.startsWith("/") ? name.slice(1) : name;
}

/**
 * Pick the sandbox name from the list Docker reports for one container.
 *
 * A container can carry several names (network aliases add them), so the
 * matching one is selected rather than assuming the first.
 */
export function pickSandboxContainerName(names: string[]): string | null {
  for (const raw of names) {
    const name = normalizeContainerName(raw);
    if (isSandboxContainerName(name)) {
      return name;
    }
  }
  return null;
}

/**
 * Read the writable-layer size Docker reports for `size: true` listings.
 *
 * Narrowed from `unknown` rather than cast: dockerode's `ContainerInfo` type
 * does not declare `SizeRw` at all — the field only appears when the listing
 * asked for sizes — so the alternative is an assertion that would happily
 * survive the field disappearing and report every container as 0 bytes.
 */
function readWritableBytes(container: unknown): number {
  if (!container || typeof container !== "object") {
    return 0;
  }
  const size = (container as { SizeRw?: unknown }).SizeRw;
  return typeof size === "number" && Number.isFinite(size) ? size : 0;
}

/**
 * Every `paco-sbx-*` container on the host, running or not.
 *
 * `size: true` makes Docker compute each writable layer, which is slower than a
 * plain list. It is asked for anyway because the whole point of this listing is
 * to tell an operator how much disk they can get back, and a report that
 * estimates is worse than no report.
 */
export async function listSandboxContainers(): Promise<SandboxContainerInfo[]> {
  const docker = new Docker();
  const containers = await docker.listContainers({ all: true, size: true });

  const found: SandboxContainerInfo[] = [];
  for (const container of containers) {
    const name = pickSandboxContainerName(container.Names ?? []);
    if (!name) {
      continue;
    }
    found.push({
      id: container.Id,
      name,
      state: container.State,
      running: container.State === "running",
      createdAtSeconds: container.Created,
      writableBytes: readWritableBytes(container),
    });
  }

  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Stop and delete one sandbox container.
 *
 * The name is re-resolved against the live listing instead of being handed to
 * `getContainer` directly. That listing only ever yields `paco-sbx-*`, so a
 * name that is not Paco's cannot reach the daemon at all — a typo, a stale
 * client, or a crafted request gets "not a Paco sandbox container" rather than
 * removing something that belongs to somebody else.
 *
 * Volumes are deliberately not removed: a sandbox's workspace is a bind mount
 * from the host, so the container holds no data of its own worth keeping — and
 * nothing that a `-v` would legitimately reach either.
 */
export async function removeSandboxContainer(name: string): Promise<void> {
  if (!isSandboxContainerName(name)) {
    throw new Error(
      `Refusing to remove a container that is not Paco's: ${name}`,
    );
  }

  const docker = new Docker();
  const containers = await docker.listContainers({ all: true });
  const match = containers.find((container) =>
    (container.Names ?? []).some(
      (candidate) => normalizeContainerName(candidate) === name,
    ),
  );

  if (!match) {
    // Already gone. Removal is the desired end state, so this is success.
    return;
  }

  if (
    !isSandboxContainerName(pickSandboxContainerName(match.Names ?? []) ?? "")
  ) {
    throw new Error(
      `Refusing to remove a container that is not Paco's: ${name}`,
    );
  }

  try {
    await docker.getContainer(match.Id).remove({ force: true, v: false });
  } catch (error) {
    // 404: removed between the listing and the call. Same end state.
    if ((error as { statusCode?: number }).statusCode !== 404) {
      throw error;
    }
  }
}
