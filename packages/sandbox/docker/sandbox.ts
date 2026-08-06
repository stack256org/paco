import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import Docker from "dockerode";
import type {
  ExecResult,
  Sandbox,
  SandboxHooks,
  SandboxStats,
} from "../interface.ts";
import {
  CONTAINER_WORKDIR,
  resolveGitUser,
  SANDBOX_IMAGE,
  DEFAULT_PORTS,
  DEFAULT_TIMEOUT_MS,
  type DockerSandboxConfig,
  toContainerName,
} from "./config.ts";
import { BASELINE_GITIGNORE } from "./baseline-gitignore.ts";
import { ContainerIdleTimer } from "./idle-timer.ts";
import { REPO_DIRNAME, repoDir } from "./layout.ts";
import { migrateLegacyWorkspace } from "./worktree.ts";
import type { DockerState } from "./state.ts";

const MAX_OUTPUT_LENGTH = 50_000;

function truncateCommandOutput(output: string): {
  output: string;
  truncated: boolean;
} {
  if (output.length <= MAX_OUTPUT_LENGTH) {
    return { output, truncated: false };
  }

  return { output: output.slice(0, MAX_OUTPUT_LENGTH), truncated: true };
}

/**
 * Labels applied to every sandbox container, with caller labels merged over
 * the base `paco.sandbox` identification labels.
 *
 * Caller labels win on key collision: they carry a chat's Traefik routing
 * (built by `previewLabels`, see `apps/web/lib/preview/labels.ts`), and this
 * module has no business overriding that. In practice the two label sets
 * don't share a key at all — Traefik's are namespaced under `traefik.*` —
 * but the merge order is still the contract callers can rely on.
 */
export function buildContainerLabels(
  name: string,
  labels?: Record<string, string>,
): Record<string, string> {
  return {
    "paco.sandbox": "true",
    "paco.sandbox.name": name,
    ...labels,
  };
}

/**
 * Docker's create-time networking config for an optional named network.
 *
 * `undefined` when no network is requested, which leaves container creation
 * exactly as it was before this option existed: Docker's default bridge
 * network, untouched. Most sandboxes — anything with no preview configured —
 * have no reason to join Traefik's network at all.
 */
export function buildNetworkingConfig(
  network: string | undefined,
): Docker.ContainerCreateOptions["NetworkingConfig"] | undefined {
  if (!network) {
    return;
  }
  return { EndpointsConfig: { [network]: {} } };
}

/**
 * Create a Docker network by name, tolerating one that already exists.
 *
 * `docker compose up` creates `PREVIEW_NETWORK_NAME` as a side effect of
 * bringing up the stack, but a sandbox is created by this app talking to
 * the host's Docker daemon directly — outside that compose project's own
 * lifecycle (see the comment on `PREVIEW_NETWORK_NAME` in
 * `apps/web/lib/sandbox/config.ts`). Without this, the very first sandbox
 * created before (or without) `docker compose up` — `pnpm web` against a
 * plain Docker daemon is the common case — failed at creation with "network
 * paco-preview not found," every time, because nothing else was responsible
 * for creating it.
 *
 * A 409 from the Docker API means a network with this name already exists,
 * which is exactly the outcome wanted, not an error to surface. Every
 * container that joins this network gets Docker's embedded DNS, so two
 * sandboxes sharing it can resolve and reach each other by container name —
 * worth knowing before pointing an untrusted sandbox at a shared network.
 */
export async function ensureNetworkExists(
  docker: Docker,
  name: string,
): Promise<void> {
  try {
    await docker.createNetwork({ Name: name });
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== 409) {
      throw error;
    }
  }
}

interface DockerCliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  canceled: boolean;
}

/**
 * Run the `docker` CLI and collect its output.
 *
 * On timeout or cancellation the child is sent SIGKILL: it is a `docker exec`
 * client process, so killing it detaches from the command rather than leaving
 * a half-read stream behind.
 */
function runDockerCli(
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
  env?: Record<string, string>,
): Promise<DockerCliResult> {
  return new Promise((resolve, reject) => {
    // `env` carries the *values* that `args` names with a bare `-e NAME`.
    // Putting them here rather than in the argument vector is the whole point:
    // a child process's environment is private to it and to root, while its
    // argv is readable by every account on the machine through `ps`.
    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let canceled = false;
    let settled = false;

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const onCancel = () => {
      canceled = true;
      child.kill("SIGKILL");
    };

    if (signal?.aborted) {
      onCancel();
    } else {
      signal?.addEventListener("abort", onCancel, { once: true });
    }

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCancel);
    };

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({ exitCode: code, stdout, stderr, timedOut, canceled });
    });
  });
}

/**
 * Build the argument vector for one `docker exec`.
 *
 * Environment variables are named, never spelled out: `-e GITHUB_TOKEN`, not
 * `-e GITHUB_TOKEN=ghp_…`. Docker copies the value from the `docker` client's
 * own environment, which `runDockerCli` sets on the child.
 *
 * The difference is who can read it. A process's argv is world-readable — any
 * account on the host can run `ps` and see the full command line of every
 * process, including this one — while its environment is visible only to itself
 * and to root. The value form leaked the user's GitHub token to every user on
 * the machine for as long as the command ran. `AGENTS.md` states the rule for
 * `gh` ("the token goes in the environment, never in argv"); this path is the
 * same token and the same rule.
 */
export function buildDockerExecArgs(params: {
  containerId: string;
  cwd: string;
  envNames: string[];
  command: string;
}): string[] {
  return [
    "exec",
    "-w",
    params.cwd,
    ...params.envNames.flatMap((name) => ["-e", name]),
    params.containerId,
    "bash",
    "-lc",
    params.command,
  ];
}

/**
 * Resolve a caller-supplied path against the workspace root.
 *
 * Absolute paths arrive in two shapes, because the workspace is mounted twice.
 * Callers inside the container speak in `/workspace/...`; callers on the host —
 * which is most of the app now that chats resolve their own worktree — speak in
 * the real host path. Both name the same file, and both are accepted.
 *
 * Handling only the container form was a real defect: every host path resolved
 * to `../Users/...` relative to `/workspace`, tripped the escape guard, and
 * surfaced as "Failed to load workspace file" for any file opened from the git
 * panel.
 *
 * Tool input reaches this method, so a path that genuinely escapes the
 * workspace is rejected rather than clamped: silently rewriting
 * `../../etc/passwd` to something inside the workspace would hide the attempt
 * from the caller.
 */
function resolveInWorkspace(hostWorkspace: string, target: string): string {
  const root = path.resolve(hostWorkspace);

  let candidate: string;
  if (!path.isAbsolute(target)) {
    candidate = path.resolve(root, target);
  } else if (target === root || target.startsWith(`${root}${path.sep}`)) {
    // Already a host path inside the workspace.
    candidate = path.resolve(target);
  } else {
    // Container form: /workspace/... maps onto the workspace root.
    candidate = path.resolve(root, path.relative(CONTAINER_WORKDIR, target));
  }

  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes the sandbox workspace: ${target}`);
  }

  return candidate;
}

/**
 * Map a host path to the path the container sees.
 *
 * They are the same path. The workspace is mounted twice — at `/workspace` and
 * at its own host path — so a host path is directly usable inside the
 * container. Translating it to `/workspace/...` instead is not merely
 * redundant, it is harmful: `git worktree add` records the absolute location
 * of both the repository and the worktree, and a worktree created under
 * `/workspace` is unreachable from the host, where the agent actually runs.
 */
function toContainerPath(hostWorkspace: string, hostPath: string): string {
  const relative = path.relative(path.resolve(hostWorkspace), hostPath);
  return relative
    ? path.posix.join(path.resolve(hostWorkspace), relative)
    : path.resolve(hostWorkspace);
}

/**
 * The slice of dockerode `ensureSandboxImage` actually uses.
 *
 * Narrow on purpose. The whole reason this function lives at module scope
 * rather than as a private static on the class is so it can be exercised
 * without a Docker daemon, and a parameter typed as the full `Docker` cannot be
 * faked in a test without lying about a hundred methods it never calls.
 */
export interface SandboxImageHost {
  getImage(name: string): { inspect(): Promise<unknown> };
  pull(name: string): Promise<NodeJS.ReadableStream>;
  modem: {
    followProgress(
      stream: NodeJS.ReadableStream,
      onFinished: (err: Error | null) => void,
    ): void;
  };
}

/**
 * Make sure `image` is on this host, pulling it if it is not.
 *
 * Local first, and that order is load-bearing twice over: a developer who has
 * built the image themselves keeps their build rather than having it replaced
 * from the registry, and a host that already has it never touches the network
 * to start a chat.
 *
 * There used to be a special case here that refused to pull the default image
 * at all, throwing "is not built. Run: docker build -t paco-sandbox:latest
 * packages/sandbox/docker" instead. That was true when the image existed only
 * in this repository — but `release.yml` has published it to ghcr.io since, and
 * the advice was impossible to follow on a host installed from the .deb, which
 * has no checkout. The result was an install that served its UI and then failed
 * every single chat. The special case is gone; the default image is a real
 * registry reference and is pulled like any other.
 */
export async function ensureSandboxImage(
  docker: SandboxImageHost,
  image: string,
): Promise<void> {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch {
    // Not present locally — fall through to pull.
  }

  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    docker.modem.followProgress(stream, (err: Error | null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

export class DockerSandbox implements Sandbox {
  readonly type = "docker" as const;
  readonly host = "localhost";
  readonly hooks?: SandboxHooks;

  #container: Docker.Container;
  #config: DockerSandboxConfig;
  #ports: number[];
  #portBindings: Map<number, number>;
  #expiresAt: number;
  #timeout: number;
  #githubToken?: string;
  #idleTimer: ContainerIdleTimer;

  private constructor(params: {
    container: Docker.Container;
    config: DockerSandboxConfig;
    ports: number[];
    portBindings: Map<number, number>;
  }) {
    this.#container = params.container;
    this.#config = params.config;
    this.#ports = params.ports;
    this.#portBindings = params.portBindings;
    this.#timeout = params.config.timeout ?? DEFAULT_TIMEOUT_MS;
    this.#expiresAt = Date.now() + this.#timeout;
    this.hooks = params.config.hooks;
    // Keyed by container, so constructing this instance takes the idle timer
    // over from whichever earlier instance was holding it for the same
    // container. See `ContainerIdleTimer`.
    this.#idleTimer = new ContainerIdleTimer(
      toContainerName(params.config.name),
    );
    this.#armTimeout();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Create (or reconnect to) a Docker-backed sandbox.
   *
   * Reconnect is name-based and idempotent: an existing container with the same
   * name is reused, a stopped one is restarted, and only a genuinely missing
   * container is created. This is what makes `resume` survive a host restart.
   */
  static async create(config: DockerSandboxConfig): Promise<DockerSandbox> {
    const docker = new Docker();
    const containerName = toContainerName(config.name);
    const hostWorkspace = path.resolve(config.hostWorkspace);
    const ports = config.ports ?? [...DEFAULT_PORTS];

    await fs.mkdir(hostWorkspace, { recursive: true });

    if (config.network) {
      await ensureNetworkExists(docker, config.network);
    }

    const existing = await DockerSandbox.#findContainer(docker, containerName);

    if (existing) {
      const info = await existing.inspect();
      if (!info.State.Running) {
        await existing.start();
      }
      const sandbox = new DockerSandbox({
        container: existing,
        config: { ...config, hostWorkspace },
        ports,
        portBindings: DockerSandbox.#readPortBindings(await existing.inspect()),
      });
      // Reapplied on reconnect, not only at creation. Containers made before
      // the identity fix carry an empty `user.name`, which git rejects on every
      // commit — and a container outlives the upgrade that fixed it, so
      // repairing only new ones would leave existing sessions broken forever.
      await sandbox.#applyGitIdentity();
      await sandbox.hooks?.afterStart?.(sandbox);
      return sandbox;
    }

    await ensureSandboxImage(docker, config.image ?? SANDBOX_IMAGE);

    const exposedPorts: Record<string, Record<string, never>> = {};
    const portBindings: Record<string, Array<{ HostPort: string }>> = {};
    for (const port of ports) {
      exposedPorts[`${port}/tcp`] = {};
      // HostPort "0" asks Docker for an ephemeral port, which avoids collisions
      // when several sandboxes run concurrently on one machine.
      portBindings[`${port}/tcp`] = [{ HostPort: "0" }];
    }

    const container = await docker.createContainer({
      name: containerName,
      Image: config.image ?? SANDBOX_IMAGE,
      WorkingDir: CONTAINER_WORKDIR,
      // Keep PID 1 alive so the container outlives individual exec calls.
      Cmd: ["sleep", "infinity"],
      Tty: false,
      Env: Object.entries(config.env ?? {}).map(([k, v]) => `${k}=${v}`),
      ExposedPorts: exposedPorts,
      NetworkDisabled: config.networkDisabled ?? false,
      Labels: buildContainerLabels(config.name, config.labels),
      NetworkingConfig: buildNetworkingConfig(config.network),
      HostConfig: {
        /*
         * Mounted twice, at the same source.
         *
         * `/workspace` is the stable path everything in the product refers to.
         * The second bind makes the workspace reachable inside the container
         * at the *same* absolute path it has on the host, which is what git
         * worktrees need: git records an absolute path in the two files that
         * join a worktree to its repository, and the agent runs on the host
         * while worktrees are created in the container. One path that is true
         * on both sides is the only arrangement where neither side sees a
         * broken link.
         */
        Binds: [
          `${hostWorkspace}:${CONTAINER_WORKDIR}`,
          `${hostWorkspace}:${hostWorkspace}`,
        ],
        PortBindings: portBindings,
        AutoRemove: false,
        ...(config.memoryBytes ? { Memory: config.memoryBytes } : {}),
        ...(config.cpus
          ? { NanoCpus: Math.round(config.cpus * 1_000_000_000) }
          : {}),
      },
    });

    await container.start();

    const sandbox = new DockerSandbox({
      container,
      config: { ...config, hostWorkspace },
      ports,
      portBindings: DockerSandbox.#readPortBindings(await container.inspect()),
    });

    await sandbox.#bootstrapWorkspace();
    await sandbox.hooks?.afterStart?.(sandbox);
    return sandbox;
  }

  static async #findContainer(
    docker: Docker,
    name: string,
  ): Promise<Docker.Container | undefined> {
    const containers = await docker.listContainers({
      all: true,
      filters: { name: [name] },
    });

    // Docker name filters are substring matches, so confirm an exact hit.
    const match = containers.find((c) =>
      c.Names.some((n) => n === `/${name}` || n === name),
    );

    return match ? docker.getContainer(match.Id) : undefined;
  }

  static #readPortBindings(
    info: Docker.ContainerInspectInfo,
  ): Map<number, number> {
    const bindings = new Map<number, number>();
    const ports = info.NetworkSettings?.Ports ?? {};

    for (const [key, value] of Object.entries(ports)) {
      const containerPort = Number.parseInt(key.split("/")[0] ?? "", 10);
      const hostPort = Number.parseInt(value?.[0]?.HostPort ?? "", 10);
      if (Number.isFinite(containerPort) && Number.isFinite(hostPort)) {
        bindings.set(containerPort, hostPort);
      }
    }

    return bindings;
  }

  /**
   * Prepare a fresh workspace: git identity, and `git init` when empty.
   *
   * The repository lives at `repo/` rather than at the workspace root so that
   * each chat's worktree can be its sibling under `chats/`. Git resolves a
   * worktree through its parent repository, so both have to sit inside the one
   * bind mount.
   *
   * The identity is set with `--global`, which writes to the container's own
   * `~/.gitconfig`: a per-repository setting would have to be repeated for the
   * repository and skipped for worktrees (they share its config), and the
   * container is single-tenant, so global is both simpler and correct.
   */
  async #applyGitIdentity(): Promise<void> {
    const gitUser = resolveGitUser(this.#config.gitUser);
    await this.exec(
      `git config --global user.name ${JSON.stringify(gitUser.name)}`,
      CONTAINER_WORKDIR,
      10_000,
    );
    await this.exec(
      `git config --global user.email ${JSON.stringify(gitUser.email)}`,
      CONTAINER_WORKDIR,
      10_000,
    );
  }

  async #bootstrapWorkspace(): Promise<void> {
    await this.#applyGitIdentity();

    // A workspace created before worktrees has its repository at the root.
    // Relocate it before anything else looks for `repo/`.
    await migrateLegacyWorkspace(this, this.#config.hostWorkspace);

    if (this.#config.skipGitWorkspaceBootstrap) {
      return;
    }

    // Created on the HOST, not with `exec("mkdir -p …")` inside the container.
    //
    // The container has no `User:` and the image sets no `USER`, so it runs as
    // root — and on a Linux bind mount a directory it creates is root-owned on
    // the host too. `#ensureBaselineGitignore` below then writes into that
    // directory through `writeFile`, which is host-side `fs`, as an
    // unprivileged user. The result is EACCES on every fresh workspace:
    //
    //   EACCES: permission denied, open '…/repo/.gitignore'
    //
    // It is invisible on macOS, where Docker Desktop maps all container-created
    // files to the host user, and Linux is the only supported production
    // platform — so this only ever showed up once CI ran on Linux.
    //
    // Creating it host-side costs nothing and fixes the direction that matters:
    // root inside the container can still write into a directory owned by the
    // host user, while the reverse is what fails. Everything git does here
    // stays in the container, as before.
    const repo = repoDir(this.#config.hostWorkspace);
    await fs.mkdir(repo, { recursive: true });
    const isRepo = await this.exec(
      "git rev-parse --is-inside-work-tree",
      repo,
      10_000,
    );

    if (!isRepo.success) {
      await this.exec("git init -b main", repo, 30_000);
    }

    await this.#ensureBaselineGitignore();
  }

  /**
   * Give a fresh workspace a baseline `.gitignore`.
   *
   * Without one, the first `npm install` makes every file under `node_modules`
   * and `.next` an untracked file the diff viewer must read. That was not
   * hypothetical: a scaffolded Next.js app produced a 650,000-line diff whose
   * serialisation exhausted the server's heap, and it carried Turbopack's binary
   * cache files, which Postgres rejects outright because JSON text cannot hold a
   * NUL byte.
   *
   * Only written when absent, so a cloned repository's own rules always win.
   */
  async #ensureBaselineGitignore(): Promise<void> {
    const existing = await this.exec(
      "test -e .gitignore && echo present || echo absent",
      repoDir(this.#config.hostWorkspace),
      10_000,
    );

    if (existing.stdout.trim() !== "absent") {
      return;
    }

    await this.writeFile(
      `${REPO_DIRNAME}/.gitignore`,
      BASELINE_GITIGNORE,
      "utf-8",
    );
  }

  #armTimeout(): void {
    this.#idleTimer.arm(this.#expiresAt, () => {
      // A rejection here used to be unhandled: `#onTimeout` talks to Docker,
      // and a daemon that is down or a container that has already gone would
      // take the whole process down with it. Reaping an idle sandbox is
      // best-effort by nature — the lifecycle workflow reclaims it either way.
      this.#onTimeout().catch((error: unknown) => {
        console.error(
          `[Sandbox] Failed to stop idle container ${toContainerName(this.#config.name)}:`,
          error,
        );
      });
    });
  }

  #clearTimeout(): void {
    this.#idleTimer.release();
  }

  async #onTimeout(): Promise<void> {
    await this.hooks?.onTimeout?.(this);
    await this.stop();
  }

  // ---------------------------------------------------------------------------
  // Metadata
  // ---------------------------------------------------------------------------

  /**
   * The session's repository.
   *
   * `/workspace/repo`, not `/workspace`. The workspace root holds the
   * repository and the per-chat worktrees side by side and is not a git
   * repository itself, so anything that runs git — the diff, the commit after
   * a turn, the editor — would fail there. Callers that want a particular
   * chat's worktree ask for it by chat id instead; this is the session-wide
   * default.
   */
  get workingDirectory(): string {
    return repoDir(this.#config.hostWorkspace);
  }

  /** Absolute host path backing the workspace. */
  get hostWorkspace(): string {
    return this.#config.hostWorkspace;
  }

  get env(): Record<string, string> | undefined {
    return this.#config.env;
  }

  get expiresAt(): number {
    return this.#expiresAt;
  }

  get timeout(): number {
    return this.#timeout;
  }

  get currentBranch(): string | undefined {
    return undefined;
  }

  domain(port: number): string {
    const hostPort = this.#portBindings.get(port);
    if (!hostPort) {
      throw new Error(`Port ${port} is not published by this sandbox`);
    }
    return `http://localhost:${hostPort}`;
  }

  get environmentDetails(): string {
    const portLines = this.#ports
      .filter((port) => this.#portBindings.has(port))
      .map((port) => `  - Port ${port}: ${this.domain(port)}`);

    const ports = portLines.length
      ? `\n- Dev server URLs (start a server on one of these ports inside the sandbox, then share the URL with the user):\n${portLines.join("\n")}`
      : "";

    return [
      `- Sandbox: Docker container \`${toContainerName(this.#config.name)}\``,
      // The host path comes first because that is where the agent itself runs;
      // leading with the container path had it try /workspace and get blocked.
      `- Your working directory (you run here): ${this.#config.hostWorkspace}`,
      `- The same files inside the container: ${CONTAINER_WORKDIR} (only commands you run *in* the container see this path)`,
      ports,
    ]
      .filter(Boolean)
      .join("\n");
  }

  /**
   * Serialize the pointers needed to resume this sandbox.
   *
   * `hostWorkspace` is deliberately omitted even though the type allows it: this
   * state is persisted on the session row and handed to the browser, so
   * including it published the operator's home directory to the client for no
   * benefit. It is fully derivable from `sandboxName` (see `resolveHostWorkspace`
   * and `run-step.ts`), and older rows that still carry it keep working.
   */
  getState(): DockerState {
    return {
      sandboxName: this.#config.name,
      containerId: this.#container.id,
      expiresAt: this.#expiresAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Filesystem
  //
  // The workspace is bind-mounted, so file operations go straight to the host
  // filesystem instead of through `docker exec`. Same bytes, no per-call
  // container round-trip.
  // ---------------------------------------------------------------------------

  #resolve(target: string): string {
    return resolveInWorkspace(this.#config.hostWorkspace, target);
  }

  /**
   * Resolve a working directory for a command running inside the container.
   *
   * Callers pass three shapes: a container path (`/workspace/api`), a host path
   * into the bind-mounted workspace (`~/.paco/workspaces/<id>/api`), or a path
   * relative to the workspace root (`api`). Only the host-workspace form needs
   * translating; the rest are already container paths.
   *
   * Absolute paths outside the workspace (`/tmp`, `/usr/local/bin`) are passed
   * through untouched — they are ordinary directories in the container's own
   * filesystem, and refusing them would break commands that legitimately run
   * outside the project tree. The workspace-escape guard in `#resolve` protects
   * file reads and writes, which happen on the *host*, where escaping the
   * workspace would reach the user's real files. Command execution is confined
   * by the container itself, so it needs no such guard.
   */
  #resolveCwd(cwd: string): string {
    const hostWorkspace = path.resolve(this.#config.hostWorkspace);

    if (!path.isAbsolute(cwd)) {
      return toContainerPath(hostWorkspace, this.#resolve(cwd));
    }

    const relative = path.relative(hostWorkspace, cwd);
    const insideHostWorkspace =
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative));

    return insideHostWorkspace
      ? toContainerPath(hostWorkspace, cwd)
      : path.posix.normalize(cwd);
  }

  async readFile(filePath: string, encoding: "utf-8"): Promise<string> {
    return fs.readFile(this.#resolve(filePath), encoding);
  }

  async readFileBuffer(filePath: string): Promise<Buffer> {
    return fs.readFile(this.#resolve(filePath));
  }

  async writeFile(
    filePath: string,
    content: string,
    encoding: "utf-8",
  ): Promise<void> {
    const resolved = this.#resolve(filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, encoding);
  }

  async stat(filePath: string): Promise<SandboxStats> {
    const stats = await fs.stat(this.#resolve(filePath));
    return {
      isDirectory: () => stats.isDirectory(),
      isFile: () => stats.isFile(),
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
  }

  async access(filePath: string): Promise<void> {
    await fs.access(this.#resolve(filePath));
  }

  async mkdir(
    dirPath: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    await fs.mkdir(this.#resolve(dirPath), {
      recursive: options?.recursive ?? false,
    });
  }

  async readdir(
    dirPath: string,
    options: { withFileTypes: true },
  ): Promise<Dirent[]> {
    return fs.readdir(this.#resolve(dirPath), options);
  }

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------

  #commandEnv(): Record<string, string> {
    const env: Record<string, string> = { ...this.#config.env };
    if (this.#githubToken) {
      env.GITHUB_TOKEN = this.#githubToken;
      env.GIT_ASKPASS = "";
    }
    return env;
  }

  async exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult> {
    // Paths arrive as either container paths or host paths depending on the
    // caller; normalize so both work.
    const containerCwd = this.#resolveCwd(cwd);

    // Execution goes through the `docker` CLI rather than dockerode's exec.
    // dockerode's hijacked attach stream is unreliable across runtimes: under
    // Bun it can reject with the connection-upgrade status ("HTTP code 101")
    // instead of yielding a stream, and it blocks for the command's full
    // duration, which breaks timeouts. The CLI gives real stdout/stderr
    // separation, a true exit code, and reliable kill semantics.
    const env = this.#commandEnv();
    const args = buildDockerExecArgs({
      containerId: this.#container.id,
      cwd: containerCwd,
      envNames: Object.keys(env),
      command,
    });

    try {
      const result = await runDockerCli(args, timeoutMs, options?.signal, env);

      if (result.canceled) {
        const abortError = new Error("Command aborted");
        abortError.name = "AbortError";
        throw abortError;
      }

      if (result.timedOut) {
        return {
          success: false,
          exitCode: null,
          stdout: "",
          stderr: `Command timed out after ${timeoutMs}ms`,
          truncated: false,
        };
      }

      const out = truncateCommandOutput(result.stdout);
      const err = truncateCommandOutput(result.stderr);

      this.#touch();

      return {
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: out.output,
        stderr: err.output,
        truncated: out.truncated || err.truncated,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        return {
          success: false,
          exitCode: null,
          stdout: "",
          stderr: `Command timed out after ${timeoutMs}ms`,
          truncated: false,
        };
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }

      return {
        success: false,
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        truncated: false,
      };
    }
  }

  /**
   * Start a long-running command (dev server, watch build) without waiting.
   *
   * Uses the `docker` CLI rather than dockerode because the detached process
   * must outlive this Node process's handle on the exec stream.
   */
  async execDetached(
    command: string,
    cwd: string,
  ): Promise<{ commandId: string }> {
    const containerCwd = this.#resolveCwd(cwd);

    const child = spawn(
      "docker",
      [
        "exec",
        "-d",
        this.#container.id,
        "bash",
        "-lc",
        `cd ${JSON.stringify(containerCwd)} && ${command}`,
      ],
      { stdio: "ignore", detached: true },
    );
    child.unref();

    this.#touch();
    return { commandId: `${this.#container.id}:${Date.now()}` };
  }

  async setGitHubAuthToken(token?: string): Promise<void> {
    this.#githubToken = token;
  }

  #touch(): void {
    this.#expiresAt = Date.now() + this.#timeout;
    this.#armTimeout();
  }

  async extendTimeout(additionalMs: number): Promise<{ expiresAt: number }> {
    this.#expiresAt += additionalMs;
    this.#armTimeout();
    await this.hooks?.onTimeoutExtended?.(this, additionalMs);
    return { expiresAt: this.#expiresAt };
  }

  /**
   * Stop the container.
   *
   * The workspace is a host directory, so stopping is non-destructive and the
   * sandbox can be recreated later under the same name with state intact.
   */
  async stop(): Promise<void> {
    this.#clearTimeout();
    await this.hooks?.beforeStop?.(this);

    try {
      await this.#container.stop({ t: 5 });
    } catch (error) {
      // 304 = already stopped, 404 = already removed. Both are success here.
      const status = (error as { statusCode?: number }).statusCode;
      if (status !== 304 && status !== 404) {
        throw error;
      }
    }
  }

  /** Stop and delete the container. The host workspace is left untouched. */
  async destroy(): Promise<void> {
    await this.stop();
    try {
      await this.#container.remove({ force: true });
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) {
        throw error;
      }
    }
  }
}
