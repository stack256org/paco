import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
  /**
   * How many CPUs the daemon reports, when it answered.
   *
   * Read from the same `docker info` payload as everything else here, and used
   * to clamp a sandbox's CPU allowance — Docker refuses `NanoCpus` above this
   * with a 400 rather than clamping it itself.
   *
   * The daemon's number, not `os.cpus()`: the daemon is what enforces the
   * limit, and `DOCKER_HOST` means it is not necessarily this machine.
   */
  cpuCount?: number;
  /**
   * The daemon accepted nothing and answered nothing inside the timeout.
   *
   * Reported as `docker-not-running` because that is the right advice, but
   * flagged separately so `assertDockerUsable` can decline to retry it: a
   * probe that already burned the full timeout is not a blip, and two more of
   * them would add twenty seconds to a turn that is failing anyway.
   */
  timedOut?: boolean;
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
 * The reason tag `apps/web/lib/sandbox/provisioning-errors.ts` reads back.
 *
 * Mirrored here as a literal, not imported: `@paco/sandbox` does not depend on
 * the web app, which is the same reason `DockerPreflightFailure`'s member names
 * are duplicated rather than shared. The format is
 * `[paco:setup-reason=<reason>]` and `markSetupReason` there produces exactly
 * this; `preflight.test.ts` pins the literal so the two cannot drift silently.
 *
 * It exists because the sentence alone is not a safe carrier. A step's throw
 * reaches the workflow as `{name, message, stack}` and no further — the class
 * and every field on it are dropped by `@workflow/core`'s
 * `normalizeUnknownError` — and the surviving message arrives buried under
 * wrapper prefixes ("Step … failed after 3 retries: Workflow run … failed:
 * …"). Matching Docker's prose still works and is kept, but it is a heuristic
 * over text three layers of somebody else's code have concatenated. The tag is
 * not.
 */
function setupReasonMarker(state: DockerPreflightFailure): string {
  return `[paco:setup-reason=${state}]`;
}

/** The system-wide socket every rootful daemon creates. */
const SYSTEM_SOCKET = "/var/run/docker.sock";

/** Where a Docker Desktop install puts a per-user socket. */
function userSocketPath(home: string): string {
  return join(home, ".docker", "run", "docker.sock");
}

export interface DockerSocketResolution {
  /** The endpoint dockerode will address, in `DOCKER_HOST` form. */
  endpoint: string;
  /** True when `DOCKER_HOST` decided it, rather than modem's default probe. */
  fromEnv: boolean;
  /**
   * The system-wide socket, set only when a per-user socket won the probe and
   * this one exists as well. This is the whole diagnosis for the trap below.
   */
  shadowed?: string;
}

/**
 * Which socket dockerode will actually use — not which one it ought to.
 *
 * This reimplements `docker-modem@5.0.7/lib/modem.js` (`defaultOpts` and
 * `findDefaultUnixSocket`) rather than approximating it, because the whole
 * point is to name the socket the *client* picked. Modem's rule, verbatim:
 * `DOCKER_HOST` wins when set; otherwise it calls `fs.access` on
 * `$HOME/.docker/run/docker.sock` and uses it **if the file exists**, falling
 * back to `/var/run/docker.sock` only when it does not.
 *
 * Existence, note — not reachability. Reproduced on a developer Mac while
 * fixing this:
 *
 *   ~/.docker/run/docker.sock  present, dead (a Docker Desktop leftover)
 *   /var/run/docker.sock       alive, OrbStack, server 29.4.0
 *
 * `docker version` works, every Paco chat fails, and the error names a daemon
 * that "is not running" while one plainly is. The message below now names the
 * socket that was tried and the one that was not, which turns that from an
 * afternoon into a line.
 *
 * ## Why this does not fall back to the live socket on its own
 *
 * It would be easy to probe the shadowed socket and quietly use it. That is
 * the wrong trade, twice over:
 *
 *   - Paco does not own the choice. `dockerode` resolves the socket per
 *     connection, and every other call in `@paco/sandbox` goes through it. A
 *     preflight that succeeded against a socket the sandbox will not use turns
 *     a clear failure at the door into an obscure one halfway through creating
 *     a container — the exact failure this module exists to prevent.
 *   - Two daemons is a real configuration, not always a mistake. Silently
 *     preferring the one the operator did not name puts Paco's containers on a
 *     daemon their own `docker ps` cannot see.
 *
 * `DOCKER_HOST` is the supported answer and modem honours it, so the message
 * says so. Diagnose, do not reroute.
 */
export function resolveDockerSocket(
  env: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = existsSync,
  home: string = homedir(),
): DockerSocketResolution {
  const host = env.DOCKER_HOST?.trim();
  // `unix://` with nothing after it is not a socket path; modem treats it as
  // unset and runs the default probe, so this has to as well.
  if (host && host !== "unix://") {
    return { endpoint: host, fromEnv: true };
  }

  const userSocket = userSocketPath(home);
  if (exists(userSocket)) {
    const resolution: DockerSocketResolution = {
      endpoint: `unix://${userSocket}`,
      fromEnv: false,
    };
    return exists(SYSTEM_SOCKET)
      ? { ...resolution, shadowed: SYSTEM_SOCKET }
      : resolution;
  }

  return { endpoint: `unix://${SYSTEM_SOCKET}`, fromEnv: false };
}

/**
 * How Paco will address the daemon, for the error text.
 *
 * Now genuinely the socket dockerode picks rather than the usual one — see
 * `resolveDockerSocket`.
 */
export function dockerEndpoint(
  env: Record<string, string | undefined> = process.env,
): string {
  return resolveDockerSocket(env).endpoint;
}

/**
 * What Paco tried, when the socket it tried is not the only one on the host.
 *
 * Empty for every ordinary install. On the one host shape where dockerode
 * confidently addresses a dead socket (see `resolveDockerSocket`) this is the
 * whole diagnosis, and it names the alternative without taking it.
 */
function shadowedSocketHint(socket: DockerSocketResolution): string {
  if (!socket.shadowed) {
    return "";
  }
  return ` Paco used that socket because the file exists, which is how dockerode's docker-modem chooses when DOCKER_HOST is unset — it prefers $HOME/.docker/run/docker.sock over the system-wide one whether or not anything is listening on it. A system-wide socket also exists at ${socket.shadowed}. If that is the daemon you meant, set DOCKER_HOST=unix://${socket.shadowed} in Paco's environment, or remove the stale per-user socket.`;
}

function messageForState(
  state: DockerPreflightState,
  socket: DockerSocketResolution,
): string {
  const endpoint = socket.endpoint;
  if (state === "docker-rootless") {
    // Contains `dockerd-rootless` on purpose: `classifySetupFailureText` in
    // the web app matches that literal (along with `rootlesskit` and a
    // `/run/user/<uid>/…docker….sock` path), and a provisioning failure
    // survives the durable workflow only as a string. A message that said
    // merely "rootless" would classify as `unknown` and reach the user as the
    // generic "try again in a moment" — advice that is wrong forever here.
    return `Docker on this host runs rootless: the daemon reports SecurityOptions ${ROOTLESS_SECURITY_OPTION}, the mode dockerd-rootless.sh starts. Paco cannot use it — a sandbox runs as the host's own uid and bind-mounts the workspace, and a rootless daemon remaps every uid through /etc/subuid, so the files it writes come back owned by an id Paco cannot touch. Use the system-wide rootful daemon instead. ${setupReasonMarker(state)}`;
  }

  if (state === "docker-permission") {
    // "permission denied while trying to connect" is Docker's own wording and
    // is what the web app's `docker-permission` matcher keys on. That matcher
    // is ordered ahead of the daemon matcher for the same reason this state
    // exists: the daemon is running, and telling the reader to start one
    // wastes their afternoon.
    return `Docker is running, but permission denied while trying to connect to the Docker daemon socket at ${endpoint}. The user Paco runs as is not in the docker group, or the service has not restarted since it was added. ${setupReasonMarker(state)}`;
  }

  if (state === "docker-not-running") {
    return `Cannot connect to the Docker daemon at ${endpoint}. Is the docker daemon running?${shadowedSocketHint(socket)} ${setupReasonMarker(state)}`;
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

/**
 * `NCPU` from `docker info`, when it is a number that could be a CPU count.
 *
 * Anything else is treated as not reported. A zero, a negative or a string is
 * not a smaller host, it is a payload this code does not understand, and
 * clamping to it would shrink every sandbox on that daemon to nothing.
 */
export function readCpuCount(info: unknown): number | undefined {
  if (!info || typeof info !== "object") {
    return;
  }
  const count = (info as { NCPU?: unknown }).NCPU;
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
    return;
  }
  return count;
}

/**
 * The CPU allowance a container may actually be given.
 *
 * Docker rejects `NanoCpus` above the host's CPU count outright:
 *
 *   (HTTP code 400) bad parameter - range of CPUs is from 0.01 to 2.00,
 *   as there are only 2 CPUs available
 *
 * Paco asked for a fixed 4 regardless of the host, so every machine with
 * fewer than four CPUs failed to create a sandbox at all — with an error that
 * named CPUs and reached the user as "check that Docker is running".
 *
 * An unknown host count passes the request through unchanged. Not knowing is
 * not evidence of a small host, and inventing a ceiling would silently shrink
 * sandboxes on a daemon whose payload merely failed to parse.
 */
export function clampCpus(
  requested: number,
  hostCpus: number | undefined,
): number {
  if (
    typeof hostCpus !== "number" ||
    !Number.isFinite(hostCpus) ||
    hostCpus <= 0
  ) {
    return requested;
  }
  return Math.min(requested, hostCpus);
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
  /**
   * How long `assertDockerUsable` waits before each re-probe, in order.
   *
   * Only for tests, which would otherwise pay the real delays. Production uses
   * `TRANSIENT_RETRY_DELAYS_MS`; see the argument for the bound there.
   */
  retryDelaysMs?: readonly number[];
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
  const socket = resolveDockerSocket(options.env ?? process.env);
  const host = options.host ?? new Docker();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let info: unknown;
  try {
    const outcome = await withTimeout(host.info(), timeoutMs);
    if (outcome.timedOut) {
      return {
        state: "docker-not-running",
        usable: false,
        message: messageForState("docker-not-running", socket),
        securityOptions: [],
        timedOut: true,
      };
    }
    info = outcome.value;
  } catch (error) {
    const state = classifyDockerInfoError(error);
    return {
      state,
      usable: false,
      message: messageForState(state, socket),
      securityOptions: [],
    };
  }

  const securityOptions = readSecurityOptions(info);
  const serverVersion = readServerVersion(info);
  const cpuCount = readCpuCount(info);
  const state: DockerPreflightState = isRootlessInfo(info)
    ? "docker-rootless"
    : "ok";

  return {
    state,
    usable: state === "ok",
    message: messageForState(state, socket),
    securityOptions,
    ...(serverVersion ? { serverVersion } : {}),
    ...(cpuCount === undefined ? {} : { cpuCount }),
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
 * How long to wait before re-probing a socket that was not there, in order.
 *
 * Two extra probes, one second of waiting in the worst case, and only for
 * `docker-not-running`.
 *
 * The bound is argued from what it is for. It is not for a host with Docker
 * switched off — that is permanent, and `packaging/paco.service` ordering Paco
 * after `docker.service` is what fixes the boot race properly. It is for the
 * residue: a `systemctl restart docker` landing mid-turn, or a socket that
 * appears a moment after the unit is considered started. `dockerd` re-creates
 * `/var/run/docker.sock` in a few hundred milliseconds, so the first wait
 * covers the ordinary case and the second covers a slow one.
 *
 * Longer would be worse, not safer, and the asymmetry is the whole argument:
 * the wait is paid by *every* failing preflight, and the overwhelmingly common
 * failure is the permanent one — Docker is simply off. Seconds spent there buy
 * nothing and make an interactive turn feel broken. The durable workflow also
 * retries the whole provisioning step three times on its own, so the real
 * coverage across a turn is three of these sequences, not one.
 *
 * Excluded, deliberately:
 *   - `docker-permission`. The daemon answered and refused. Group membership
 *     is read once at process start, so nothing about this can change while
 *     the process is running. Retrying is pure latency in front of an answer
 *     that is already correct.
 *   - `docker-rootless`. A property of the daemon the operator installed. It
 *     will be just as rootless in 1.5 seconds.
 *   - A timed-out probe. It already spent the full 10s timeout; see
 *     `DockerPreflightResult.timedOut`.
 */
const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [250, 750];

/** Worth probing again in a moment? See `TRANSIENT_RETRY_DELAYS_MS`. */
function isTransientPreflightFailure(result: DockerPreflightResult): boolean {
  return result.state === "docker-not-running" && result.timedOut !== true;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Stop before creating anything when the daemon cannot support a sandbox.
 *
 * Called at the top of `DockerSandbox.create`, which is the narrowest point
 * every sandbox — new or resumed — passes through, and the place that decides
 * the uid and the bind mounts rootless breaks.
 *
 * Retries only here, and only the transient verdict. `dockerPreflight` stays a
 * single instantaneous probe because the other caller is the health page,
 * which reports what is true now and must not spend seconds doing it.
 */
export async function assertDockerUsable(
  options: DockerPreflightOptions = {},
): Promise<DockerPreflightResult> {
  let result = await dockerPreflight(options);

  for (const waitMs of options.retryDelaysMs ?? TRANSIENT_RETRY_DELAYS_MS) {
    if (!isTransientPreflightFailure(result)) {
      break;
    }
    await delay(waitMs);
    result = await dockerPreflight(options);
  }

  if (result.state === "ok") {
    return result;
  }
  throw new DockerUnusableError({ ...result, state: result.state });
}
