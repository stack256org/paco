import { connectDocker } from "./docker/connect.ts";
import type { DockerState } from "./docker/state.ts";
import type { Sandbox, SandboxHooks } from "./interface.ts";
import type { SandboxStatus } from "./types.ts";

// Re-export SandboxStatus from types for convenience
export type { SandboxStatus };

/**
 * Unified sandbox state type.
 * Use `type` discriminator to determine which sandbox implementation to use.
 */
export type SandboxState = { type: "docker" } & DockerState;

/**
 * Base connect options for all sandbox types.
 */
export interface ConnectOptions {
  /** Environment variables available to sandbox commands */
  env?: Record<string, string>;
  /** GitHub token used only during setup clone/fetch, then cleared */
  githubToken?: string;
  /** Git user for commits */
  gitUser?: { name: string; email: string };
  /** Lifecycle hooks */
  hooks?: SandboxHooks;
  /** Idle timeout in milliseconds before the sandbox is stopped */
  timeout?: number;
  /** Ports to expose from the sandbox for dev server preview URLs */
  ports?: number[];
  /** CPU limit in whole cores */
  cpus?: number;
  /** Memory limit in bytes */
  memoryBytes?: number;
  /** Container image override */
  image?: string;
  /** Disable container networking (for running untrusted code) */
  networkDisabled?: boolean;
  /** Skip git init in an empty workspace */
  skipGitWorkspaceBootstrap?: boolean;
  /** Extra labels merged over the container's own `paco.sandbox` labels */
  labels?: Record<string, string>;
  /** Name of an existing Docker network to attach the container to */
  network?: string;
  /**
   * Reconnect to an existing sandbox rather than creating one.
   *
   * Accepted for API compatibility; Docker connect is already name-keyed and
   * idempotent, so reconnect happens regardless of this flag.
   */
  resume?: boolean;
  /** Accepted for API compatibility; Docker always creates when missing. */
  createIfMissing?: boolean;
}

/**
 * Configuration for connecting to a sandbox.
 */
export type SandboxConnectConfig = {
  state: SandboxState;
  options?: ConnectOptions;
};

/**
 * Connect to a sandbox based on the provided configuration.
 *
 * Connecting is idempotent and keyed by `sandboxName`: the same name always
 * resolves to the same host workspace and container, so this covers create,
 * reconnect, and resume.
 */
export async function connectSandbox(
  configOrState: SandboxConnectConfig | SandboxState,
  legacyOptions?: ConnectOptions,
): Promise<Sandbox> {
  const isNewApi =
    typeof configOrState === "object" &&
    "state" in configOrState &&
    typeof configOrState.state === "object" &&
    "type" in configOrState.state;

  if (isNewApi) {
    const config = configOrState as SandboxConnectConfig;
    return connectDocker(config.state, config.options);
  }

  return connectDocker(configOrState as SandboxState, legacyOptions);
}
