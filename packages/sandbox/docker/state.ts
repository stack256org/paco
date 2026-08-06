import type { Source } from "../types.ts";

/**
 * Persisted state for a Docker-backed sandbox.
 *
 * Unlike the cloud provider this replaces, durability does not depend on
 * snapshots: the workspace is a real directory on the host, so state survives
 * container removal and host restarts for free. Only the pointers are stored.
 */
export interface DockerState {
  /** Where to clone from. Omit for an empty workspace or when reconnecting. */
  source?: Source;
  /**
   * Stable sandbox name. Resolves to a host workspace directory and a
   * container name, and is what allows a session to be resumed.
   */
  sandboxName?: string;
  /** Absolute host path backing the workspace. Derived from the name if unset. */
  hostWorkspace?: string;
  /** Container id, when one is currently running. */
  containerId?: string;
  /** Timestamp (ms) when the running container will be proactively stopped. */
  expiresAt?: number;
}
