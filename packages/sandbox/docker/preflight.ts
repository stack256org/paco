import Docker from "dockerode";

/**
 * Is this host's Docker daemon one Paco can actually run a sandbox on?
 *
 * Three different failures used to look identical from a chat: a daemon that
 * is not running, a daemon that is running but refuses this process, and a
 * daemon that answers everything happily and then silently breaks the
 * workspace. Only the third needs explaining here, because it is the one
 * nothing downstream can diagnose.
 *
 * ## Rootless Docker cannot work, and this is why
 *
 * `DockerSandbox.create` runs the container as the host's own uid
 * (`User: hostContainerUser()`) and bind-mounts one workspace directory
 * twice. The comment there states the constraint: "Matching the uid is the
 * only arrangement where both sides can read and write the same tree." The
 * agent edits files on the host as the service user; the container runs them;
 * git worktrees are created on one side and resolved from the other. One uid,
 * both sides.
 *
 * A rootless daemon puts the container in a user namespace, so that uid is not
 * the uid the kernel writes to disk. Measured on a real Ubuntu 24.04 host:
 * `/etc/subuid` carries `ubuntu:100000:65536`, and a process claiming
 * `uid=106 gid=109` inside the namespace produced a file owned by
 * `uid=100106 gid=100109` outside it. `paco` is uid 106 on a packaged install,
 * so the service could not read or write a single file its own sandbox
 * created, and writing into a normally-permissioned directory failed outright
 * with `Permission denied`.
 *
 * Nothing in Paco can bridge that. There is no uid the container can claim
 * that arrives on the host as the service user, and Paco is unprivileged so it
 * cannot chown its way out. The only fix is the rootful system-wide daemon,
 * which is what `install.sh` installs.
 *
 * ## Why a rootless host does not even reach this check
 *
 * `dockerode` finds its socket through `docker-modem@5.0.7/lib/modem.js:80`
 * (`findDefaultUnixSocket`), which probes exactly `$HOME/.docker/run/docker.sock`
 * and then falls back to `/var/run/docker.sock`. It never looks at
 * `$XDG_RUNTIME_DIR/docker.sock`, which is where a rootless daemon actually
 * listens — and nothing in `packaging/paco.service` or `paco.env` sets
 * `DOCKER_HOST`, which modem *does* honour (lines 20-33). So the common
 * rootless-only host reads here as `docker-not-running` even though
 * `docker info` works perfectly in the operator's own shell. That confusion is
 * the reason `docs/self-hosting.md` says rootless is unsupported in as many
 * words rather than leaving it to be inferred from a socket error.
 *
 * An operator who points `DOCKER_HOST` at the rootless socket to "fix" that
 * gets the classification below instead, which is the whole point of asking
 * the daemon rather than the filesystem.
 */

/**
 * The verdict, named to match `ProvisioningFailureReason` in
 * `apps/web/lib/sandbox/provisioning-errors.ts`.
 *
 * The names are deliberately identical so the seam between this package and
 * the web app's failure copy is a lookup rather than a translation. This
 * module never imports that type — `@paco/sandbox` does not depend on the web
 * app — so the two lists are kept in step by name alone.
 *
 * `docker-missing` is absent on purpose. It means "there is no `docker`
 * binary", which is a `spawn` error the CLI paths report; an unreachable
 * socket cannot tell an uninstalled Docker from a stopped one, and guessing
 * "not installed" on a host where `install.sh` installed it sends the reader
 * somewhere useless.
 */
export type DockerPreflightFailure =
  | "docker-not-running"
  | "docker-permission"
  | "docker-rootless";

export type DockerPreflightState = "ok" | DockerPreflightFailure;

export interface DockerPreflightResult {
  state: DockerPreflightState;
  /** `true` only for `ok`. A sandbox may be created. */
  usable: boolean;
  /**
   * One sentence, for a log line or an error message — never shown to a user
   * verbatim. The web app turns the *state* into user-facing copy
   * (`setup-failure-copy.ts`); this text exists so that a failure flattened to
   * a string somewhere still classifies back to the same state.
   */
  message: string;
  /** What the daemon reported, when it answered. Empty when it did not. */
  securityOptions: readonly string[];
  /** The daemon's version string, when it answered. */
  serverVersion?: string;
}

/** The one call this needs. Narrower than `Dockerode` so tests can fake it. */
export interface DockerInfoHost {
  info(): Promise<unknown>;
}

/**
 * The security option a rootless daemon reports.
 *
 * `docker info` exposes it as an entry in `SecurityOptions`, alongside
 * `name=apparmor`, `name=seccomp,profile=builtin` and `name=cgroupns`. It is
 * the daemon's own statement about itself, which is why this asks for it
 * rather than sniffing socket paths or process names: an operator can move the
 * socket anywhere, but a rootless daemon always says so here.
 */
const ROOTLESS_SECURITY_OPTION = "name=rootless";

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * How Paco will address the daemon, for the error text.
 *
 * Mirrors `docker-modem`'s own resolution closely enough to be useful in a
 * message: `DOCKER_HOST` wins when set, and the fallback is the system-wide
 * socket. Deliberately does not claim to know which of modem's two probed
 * paths won — a message that names the wrong socket is worse than one that
 * names the usual one.
 */
export function dockerEndpoint(
  env: Record<string, string | undefined> = process.env,
): string {
  const host = env.DOCKER_HOST?.trim();
  return host ? host : "unix:///var/run/docker.sock";
}

function messageForState(
  state: DockerPreflightState,
  endpoint: string,
): string {
  if (state === "docker-rootless") {
    // Contains `dockerd-rootless` on purpose: `classifySetupFailureText` in
    // the web app matches that literal (along with `rootlesskit` and a
    // `/run/user/<uid>/…docker….sock` path), and a provisioning failure
    // survives the durable workflow only as a string. A message that said
    // merely "rootless" would classify as `unknown` and reach the user as the
    // generic "try again in a moment" — advice that is wrong forever here.
    return `Docker on this host runs rootless: the daemon reports SecurityOptions ${ROOTLESS_SECURITY_OPTION}, the mode dockerd-rootless.sh starts. Paco cannot use it — a sandbox runs as the host's own uid and bind-mounts the workspace, and a rootless daemon remaps every uid through /etc/subuid, so the files it writes come back owned by an id Paco cannot touch. Use the system-wide rootful daemon instead.`;
  }

  if (state === "docker-permission") {
    // "permission denied while trying to connect" is Docker's own wording and
    // is what the web app's `docker-permission` matcher keys on. That matcher
    // is ordered ahead of the daemon matcher for the same reason this state
    // exists: the daemon is running, and telling the reader to start one
    // wastes their afternoon.
    return `Docker is running, but permission denied while trying to connect to the Docker daemon socket at ${endpoint}. The user Paco runs as is not in the docker group, or the service has not restarted since it was added.`;
  }

  if (state === "docker-not-running") {
    return `Cannot connect to the Docker daemon at ${endpoint}. Is the docker daemon running?`;
  }

  return `Docker is reachable at ${endpoint}.`;
}

/** Every `SecurityOptions` entry the daemon reported, one per component. */
export function readSecurityOptions(info: unknown): readonly string[] {
  if (!info || typeof info !== "object") {
    return [];
  }

  const raw = (info as { SecurityOptions?: unknown }).SecurityOptions;
  if (!Array.isArray(raw)) {
    return [];
  }

  // Each entry can itself be a comma-joined list — `name=seccomp,profile=builtin`
  // is the one every daemon reports — so the entries are split rather than
  // compared whole. `name=rootless` arrives on its own today; splitting means
  // a daemon that ever joins it to another option still classifies.
  const options: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      continue;
    }
    for (const part of entry.split(",")) {
      const trimmed = part.trim();
      if (trimmed) {
        options.push(trimmed);
      }
    }
  }
  return options;
}

/** Whether a `docker info` payload describes a rootless daemon. */
export function isRootlessInfo(info: unknown): boolean {
  return readSecurityOptions(info).includes(ROOTLESS_SECURITY_OPTION);
}

function readServerVersion(info: unknown): string | undefined {
  if (!info || typeof info !== "object") {
    return;
  }
  const version = (info as { ServerVersion?: unknown }).ServerVersion;
  return typeof version === "string" && version ? version : undefined;
}

/**
 * Refused, or not there at all?
 *
 * `EACCES`/`EPERM` on the socket is the packaged install's most common
 * failure: the daemon is up and the service user is not in the `docker`
 * group. Everything else — `ENOENT` for a socket that does not exist,
 * `ECONNREFUSED` for one nothing is listening on — is a daemon that is not
 * running, and is reported as such rather than guessed at further.
 *
 * A `403` is included because a daemon behind a proxy answers rather than
 * refusing the connection, and that is still "you may not use this", not
 * "start it".
 */
export function classifyDockerInfoError(
  error: unknown,
): "docker-permission" | "docker-not-running" {
  if (!error || typeof error !== "object") {
    return "docker-not-running";
  }

  const code = (error as { code?: unknown }).code;
  if (code === "EACCES" || code === "EPERM") {
    return "docker-permission";
  }

  const status = (error as { statusCode?: unknown }).statusCode;
  if (status === 403) {
    return "docker-permission";
  }

  const message = (error as { message?: unknown }).message;
  if (
    typeof message === "string" &&
    /permission denied|not permitted/i.test(message)
  ) {
    return "docker-permission";
  }

  return "docker-not-running";
}

/**
 * A daemon that never answers is not a usable daemon.
 *
 * `dockerode` sets no timeout of its own, so a wedged socket hangs whoever
 * called this — a chat starting up, or the health page, which is exactly where
 * an unbounded wait turns one broken thing into a page of permanent
 * skeletons.
 */
async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    // Never hold the process open on this timer; the work settles it first in
    // every case that matters.
    timer.unref?.();
  });

  try {
    // A rejection from `work` propagates rather than being raced away — the
    // caller classifies it, and swallowing it here would report every refused
    // socket as a timeout.
    return await Promise.race([
      work.then((value) => ({ timedOut: false as const, value })),
      expiry,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface DockerPreflightOptions {
  /** Defaults to a real `dockerode` client. */
  host?: DockerInfoHost;
  /** Defaults to 10s. */
  timeoutMs?: number;
  /** Defaults to `process.env`. Only read for `DOCKER_HOST`, for the message. */
  env?: Record<string, string | undefined>;
}

/**
 * Ask the daemon about itself and decide whether Paco can use it.
 *
 * Returns a value rather than throwing: one caller wants to fail a chat
 * (`assertDockerUsable`), and the other wants to render a health card, and a
 * thrown string serves neither.
 */
export async function dockerPreflight(
  options: DockerPreflightOptions = {},
): Promise<DockerPreflightResult> {
  const endpoint = dockerEndpoint(options.env ?? process.env);
  const host = options.host ?? new Docker();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let info: unknown;
  try {
    const outcome = await withTimeout(host.info(), timeoutMs);
    if (outcome.timedOut) {
      return {
        state: "docker-not-running",
        usable: false,
        message: messageForState("docker-not-running", endpoint),
        securityOptions: [],
      };
    }
    info = outcome.value;
  } catch (error) {
    const state = classifyDockerInfoError(error);
    return {
      state,
      usable: false,
      message: messageForState(state, endpoint),
      securityOptions: [],
    };
  }

  const securityOptions = readSecurityOptions(info);
  const serverVersion = readServerVersion(info);
  const state: DockerPreflightState = isRootlessInfo(info)
    ? "docker-rootless"
    : "ok";

  return {
    state,
    usable: state === "ok",
    message: messageForState(state, endpoint),
    securityOptions,
    ...(serverVersion ? { serverVersion } : {}),
  };
}

/**
 * The failure a sandbox path throws.
 *
 * Carries the state as a field for anything in-process, and the same reason in
 * `message` for everything downstream of the durable workflow, which only ever
 * sees a string.
 */
export class DockerUnusableError extends Error {
  readonly state: DockerPreflightFailure;
  readonly preflight: DockerPreflightResult;

  constructor(
    preflight: DockerPreflightResult & { state: DockerPreflightFailure },
  ) {
    super(preflight.message);
    this.name = "DockerUnusableError";
    this.state = preflight.state;
    this.preflight = preflight;
  }
}

/**
 * Stop before creating anything when the daemon cannot support a sandbox.
 *
 * Called at the top of `DockerSandbox.create`, which is the narrowest point
 * every sandbox — new or resumed — passes through, and the place that decides
 * the uid and the bind mounts rootless breaks.
 */
export async function assertDockerUsable(
  options: DockerPreflightOptions = {},
): Promise<DockerPreflightResult> {
  const result = await dockerPreflight(options);
  if (result.state === "ok") {
    return result;
  }
  throw new DockerUnusableError({ ...result, state: result.state });
}
