import {
  type ChildProcessWithoutNullStreams,
  execFile,
  spawn,
} from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, realpath } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { Capability, PluginDescriptor } from "@paco/plugin-kit";
import type { LineReader } from "./line-reader.ts";
import { readLines } from "./line-reader.ts";
import { checkFetchAllowed } from "./net-allowlist.ts";
import {
  encodeMessage,
  type HostToWorkerMessage,
  type PluginSlots,
  type RegisteredTool,
  workerToHostSchema,
} from "./protocol.ts";

/** How many protocol violations a worker gets before the host kills it. */
const MAX_MALFORMED_MESSAGES = 5;
/** How long `start()` waits for the worker's `ready` handshake. */
const DEFAULT_READY_TIMEOUT_MS = 10_000;
/** Default ceiling on a single tool invocation. */
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
/** Default ceiling on one inbound channel webhook, per the plan. */
const DEFAULT_INGRESS_TIMEOUT_MS = 10_000;
/** How long `stop()` waits after `shutdown` before SIGKILL. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3000;
/** Ceiling on retained worker stderr, so a chatty plugin cannot grow it. */
const MAX_STDERR_BYTES = 16_000;
/** Capability requests a plugin may have outstanding at once. */
const MAX_INFLIGHT_CAPABILITY_REQUESTS = 32;
/** Worker `log` messages accepted per second before the rest are dropped. */
const MAX_LOGS_PER_SECOND = 50;

/** Plugin ids, per the plan. Mirrors the plugin-kit manifest rule. */
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

/**
 * The oldest Node that may run a hardened plugin worker.
 *
 * Node >= 24 gates network sockets inside the permission model, so it is the
 * backstop behind `worker-preload.ts`. On 22.x there is no such gate and the
 * in-process allowlist is the ONLY barrier between a plugin and the network —
 * a position three adversarial reviews have now shown to be one missed name
 * away from failing. 22.x is out of support for hardened plugins.
 */
const MIN_HARDENED_NODE_MAJOR = 24;

/** Bounds on the pre-flight scan of a plugin directory. */
const MAX_PLUGIN_ENTRIES = 20_000;
const MAX_PLUGIN_DEPTH = 24;

/** Packages the worker must be able to read for its own imports to resolve. */
const WORKER_RUNTIME_PACKAGES = ["zod", "@paco/plugin-kit"] as const;

/** The two scripts the host spawns. Both live beside this file. */
const WORKER_ENTRY_FILENAME = "worker-entry.ts";
const WORKER_PRELOAD_FILENAME = "worker-preload.ts";

/**
 * Overrides where this package's own files are looked for. The escape hatch
 * for a deployment whose layout none of the candidates below describes —
 * named in the error `start()` throws when nothing resolves.
 */
const PACKAGE_DIR_ENV = "PACO_PLUGIN_HOST_DIR";

/** Injection seams, so `resolvePluginHostDir` can be tested as a pure function. */
export interface PluginHostDirLookup {
  /** `import.meta.dirname`, which a bundler leaves `undefined`. */
  moduleDir?: string | undefined;
  cwd?: string;
  override?: string | undefined;
  exists?: (candidate: string) => boolean;
}

/**
 * Absolute directory holding `worker-entry.ts` and `worker-preload.ts`.
 *
 * ## Why this is not `import.meta.dirname`
 *
 * It used to be, at module scope, and that was wrong twice over.
 *
 * The host is imported by a Next.js route (`lib/plugins/registry.ts`), so it
 * gets bundled. Turbopack rewrites `import.meta.dirname` to `undefined`, and
 * `path.join(undefined, ...)` throws `TypeError` while the module is being
 * *evaluated* — which `next build` does for every route to collect its page
 * config. One unusable constant therefore failed the entire build, blamed on
 * whichever route happened to sort first.
 *
 * Fixing only that would have left the worse half. A bundled
 * `import.meta.url`/`dirname` that resolves at all resolves into
 * `.next/server/chunks/`, so the host would have spawned workers pointing at
 * paths that do not exist and every plugin would have failed to start — a
 * runtime failure with a green build, which is strictly worse than the build
 * break that hid it. `packages/claude-code/approval.ts` documents the same
 * bundler behaviour biting the `PreToolUse` hook.
 *
 * That rules out embedding the scripts as strings the way `approval.ts` does:
 * `worker-entry.ts` imports `zod` and `@paco/plugin-kit`, so writing it to a
 * scratch directory would break its own module resolution. The worker entry
 * has to stay in the package directory, next to the `node_modules` that
 * resolves those two — which is also what `WORKER_RUNTIME_PACKAGES` needs.
 *
 * So the directory is found on the filesystem instead, from candidates that
 * are true in every environment this ships in, first hit wins:
 *
 * 1. `PACO_PLUGIN_HOST_DIR`, for a layout none of the rest describe.
 * 2. `import.meta.dirname` itself — correct and preferred whenever the module
 *    was *not* bundled: `bun test`, plain `node`, any direct import.
 * 3. `<ancestor>/node_modules/@paco/plugin-host`, walking up from the working
 *    directory. `next dev` and `next start` run with `apps/web` as the cwd,
 *    where that path is pnpm's symlink to `packages/plugin-host`. The `.deb`
 *    runs with `/usr/lib/paco/apps/web` as the cwd — Next's standalone
 *    `server.js` chdirs to its own directory — and `packaging/build-deb.sh`
 *    puts `pnpm deploy`'s `node_modules` there, so the same path applies.
 *
 *    Caveat worth knowing before debugging a `.deb`: `pnpm deploy` links
 *    `@paco/*` workspace packages as relative symlinks back into the *build
 *    machine's* checkout rather than copying them, and `build-deb.sh` stages
 *    that tree with `cp -a`, which preserves symlinks. They therefore dangle
 *    on the target and this candidate finds nothing — which is why
 *    `assertWorkerScriptsExist` names `PACO_PLUGIN_HOST_DIR` in its error
 *    rather than letting `spawn` fail with "Cannot find module". Fixing the
 *    packaging (dereferencing those links) belongs in `build-deb.sh`.
 * 4. The same walk from `import.meta.dirname`, for a bundled chunk that does
 *    know where it is — `.next/server/chunks` climbs to `apps/web`.
 *
 * Never throws, whatever it is handed: a bad answer here must surface as
 * `start()` refusing to spawn with an actionable message, never as a
 * `TypeError` during module evaluation that takes a build down with it.
 */
export function resolvePluginHostDir(lookup: PluginHostDirLookup = {}): string {
  // `in`, not a destructuring default: a default fires on an explicit
  // `undefined` too, which would make `{ moduleDir: undefined }` — the exact
  // state a bundler leaves behind, and the one worth testing — silently mean
  // "use `import.meta.dirname`".
  const moduleDir =
    "moduleDir" in lookup ? lookup.moduleDir : import.meta.dirname;
  const override =
    "override" in lookup ? lookup.override : process.env[PACKAGE_DIR_ENV];
  const cwd = lookup.cwd ?? process.cwd();
  const exists = lookup.exists ?? existsSync;

  const candidates: string[] = [];
  if (override) {
    candidates.push(path.resolve(override));
  }
  if (moduleDir) {
    candidates.push(moduleDir);
  }
  candidates.push(...installedCopiesAbove(cwd));
  if (moduleDir) {
    candidates.push(...installedCopiesAbove(moduleDir));
  }

  for (const candidate of candidates) {
    if (exists(path.join(candidate, WORKER_ENTRY_FILENAME))) {
      return candidate;
    }
  }

  // Nothing matched. Answer with the most plausible location anyway so the
  // module still evaluates; `start()` is where an unusable path becomes an
  // error, and it can say what to set.
  return moduleDir ?? path.join(cwd, "node_modules", "@paco", "plugin-host");
}

/** `<ancestor>/node_modules/@paco/plugin-host` for every ancestor of `from`. */
function installedCopiesAbove(from: string): string[] {
  const found: string[] = [];
  let dir = path.resolve(from);
  for (;;) {
    // `turbopackIgnore` because `dir` is a loop variable: without it Next's
    // build-time tracer gives up and traces the whole project into the NFT
    // list, which is how real runtime dependencies go missing from
    // `.next/standalone` (see the long comment in apps/web/next.config.ts).
    found.push(
      path.join(
        /* turbopackIgnore: true */ dir,
        "node_modules",
        "@paco",
        "plugin-host",
      ),
    );
    const parent = path.dirname(dir);
    if (parent === dir) {
      return found;
    }
    dir = parent;
  }
}

/**
 * This package's own directory. Resolved once, eagerly — which is safe
 * precisely because `resolvePluginHostDir` cannot throw.
 */
const pluginHostDir: string = resolvePluginHostDir();

/** Absolute path to the worker entry script. */
export const workerEntryPath: string = path.join(
  pluginHostDir,
  WORKER_ENTRY_FILENAME,
);

/** Absolute path to the `--import` preload that closes the network. */
export const workerPreloadPath: string = path.join(
  pluginHostDir,
  WORKER_PRELOAD_FILENAME,
);

/**
 * The worker's command line, as a pure function of what constrains it.
 *
 * Split out of `PluginHost` so a test can assert on the argv the host
 * actually builds. That matters more than tidiness: `SECURITY.md` promises
 * the worker gets "no subprocesses, threads, or native code", and the only
 * thing delivering that promise is the *absence* of `--allow-child-process`,
 * `--allow-worker` and `--allow-addons` from this array. An absence is
 * invisible in review and survives only as long as nobody appends a flag, so
 * `host.test.ts` asserts on it directly.
 */
export function buildWorkerArgv(input: {
  hardened: boolean;
  readableDirs: readonly string[];
  writableDir: string;
  preloadPath: string;
  entryPath: string;
}): string[] {
  if (!input.hardened) {
    return [input.entryPath];
  }
  return [
    "--permission",
    ...input.readableDirs.map(
      (dir) => `--allow-fs-read=${path.join(dir, "*")}`,
    ),
    `--allow-fs-write=${path.join(input.writableDir, "*")}`,
    "--import",
    input.preloadPath,
    input.entryPath,
  ];
}

export type HostLogLevel = "info" | "warn" | "error";

export interface HostLogEntry {
  level: HostLogLevel;
  message: string;
}

export type HostLogger = (entry: HostLogEntry) => void;

/**
 * Capability implementations supplied by the embedder.
 *
 * The host never implements a capability; it only decides whether the
 * plugin's grant permits reaching one of these. A capability with no entry
 * here is granted-but-unavailable, which is an error the plugin sees.
 */
export type CapabilityHandlers = Partial<
  Record<Capability, (pluginId: string, payload: unknown) => Promise<unknown>>
>;

export type ToolOutcome =
  | { ok: true; output: unknown }
  | { ok: false; error: string };

/**
 * The result of one `deliverIngress` call. Always resolves — same
 * philosophy as `ToolOutcome` — with `reason` telling the caller (the
 * `/api/channels/[pluginId]/[channel]` route) exactly which HTTP status the
 * failure maps to: `"not-granted"` and `"not-running"` both mean the plugin
 * cannot currently take the request (503-shaped), `"timeout"` means the
 * worker never answered in time (504-shaped).
 */
export type IngressOutcome =
  | { ok: true; status: number; body?: unknown }
  | {
      ok: false;
      reason: "not-granted" | "not-running" | "timeout";
      error: string;
    };

export type PluginHostState = "starting" | "running" | "crashed" | "stopped";

export interface PluginHostOptions {
  descriptor: PluginDescriptor;
  /**
   * Exactly what the operator consented to, from the database — not from the
   * manifest. A manifest is the plugin's *request*; this is the answer, and
   * it is what gets enforced. Anything here that the manifest does not also
   * declare is dropped at construction.
   */
  grantedCapabilities: Capability[];
  /**
   * The consented `net:fetch` domains, also from the database. The host never
   * reads `descriptor.manifest.netDomains`: a plugin update that widened its
   * own manifest would otherwise widen its own network access.
   */
  netDomains: string[];
  handlers: CapabilityHandlers;
  /** Production pins Paco's bundled node; defaults to `process.execPath`. */
  nodeExecutable?: string;
  /**
   * Process-level containment: Node's permission model plus the network
   * preload. Defaults to `true` and should stay true everywhere real plugin
   * code runs.
   *
   * Set it to `false` only to run the worker under a runtime that has no
   * permission model (bun, in this package's own tests). A non-hardened
   * worker is an ordinary process with the full filesystem and network.
   */
  hardened?: boolean;
  logger?: HostLogger;
  readyTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

interface PendingToolCall {
  resolve: (outcome: ToolOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingIngressCall {
  resolve: (outcome: IngressOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Runs one plugin in its own process and enforces its capability grant.
 *
 * ## What contains the plugin
 *
 * This is **process-level containment, not a container**. There is no
 * namespace, no cgroup, no seccomp filter and no memory limit. What there is:
 *
 * - **No ambient secrets.** The worker's environment is built from scratch —
 *   `PATH`, `PACO_PLUGIN_ID`, `PACO_PLUGIN_STATE_DIR` — so `APP_SECRET`,
 *   `POSTGRES_URL` and every provider token are simply absent. Not filtered:
 *   never present.
 * - **A filesystem allowlist.** Node's permission model (`--permission`)
 *   allows reads only under the plugin's own root, this package, and the two
 *   packages the worker imports; writes only under a per-plugin scratch dir.
 *   Paths outside those prefixes fail with `ERR_ACCESS_DENIED`.
 * - **A symlink rule that makes the allowlist mean something.** The
 *   permission model follows links living under an allowed prefix, so one
 *   `escape -> /` would grant the whole filesystem. `start()` therefore
 *   refuses any plugin tree containing a symbolic link — see
 *   `assertPluginTreeIsContained`. This runs in BOTH modes.
 * - **No subprocesses, workers or native addons.** `--allow-child-process`,
 *   `--allow-worker` and `--allow-addons` are deliberately not passed.
 * - **No network.** The permission model on Node >= 24 gates sockets, and
 *   `start()` refuses to run hardened on anything older. Behind that,
 *   `worker-preload.ts` deletes the network globals and confines plugin code
 *   to a small ALLOWLIST of builtins — `fs`, `path`, `crypto` and a dozen
 *   more, but NOT `os`, `net` or anything else that reads the host or
 *   reaches a socket — closing both routes to a builtin: module resolution, and
 *   `process.getBuiltinModule` / `process.binding`, which skip resolution
 *   entirely. Nothing is denied by name, so unknown, underscore-prefixed and
 *   future builtins are refused by default; a denylist here leaked
 *   `_tls_wrap` and `_http_client`. The only sanctioned way out is the
 *   `net:fetch` capability, allowlisted here.
 * - **No unbounded anything.** Line length, stderr, in-flight capability
 *   requests, log rate, tool count and tool-call duration are all capped.
 *
 * See `SECURITY.md` in this package for the full statement, including what is
 * explicitly *not* prevented — notably that a plugin can still SIGKILL the
 * host process, and that there is no CPU, memory or disk bound. Production
 * must pin `nodeExecutable` to Node >= 24. The install-consent copy must not
 * promise more than that file claims.
 *
 * ## What the host decides
 *
 * Grant checks happen here, before any handler runs. The worker is untrusted
 * code and can ask for anything; asking is not receiving. `net:fetch` is
 * narrowed further against the operator's consented domain list.
 *
 * Background failures — a crash, a protocol violation, a hung tool — resolve
 * into values (`state`, `onCrash`, `ToolOutcome`) and are never thrown into
 * the embedder, because a broken plugin must degrade rather than fail a turn.
 */
export class PluginHost {
  private readonly descriptor: PluginDescriptor;
  private readonly granted: Set<Capability>;
  private readonly netDomains: readonly string[];
  private readonly handlers: CapabilityHandlers;
  private readonly nodeExecutable: string;
  private readonly hardened: boolean;
  private readonly logger: HostLogger;
  private readonly readyTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private stateDir: string;
  private rootDir: string;
  private slots: PluginSlots;

  private child: ChildProcessWithoutNullStreams | undefined;
  private currentState: PluginHostState = "starting";
  private malformedCount = 0;
  private stderrTail = "";
  private stopping = false;
  private crashReported = false;
  private started = false;
  private callCounter = 0;
  private readerClosed = false;
  private lineReader: LineReader | null = null;
  private inFlightCapabilityRequests = 0;
  private logTokens = MAX_LOGS_PER_SECOND;
  private logWindowStart = 0;
  private logRateWarned = false;

  private readonly crashCallbacks = new Set<(error: string) => void>();
  private readonly pendingCalls = new Map<string, PendingToolCall>();
  private readonly pendingIngress = new Map<string, PendingIngressCall>();
  private ready: PromiseWithResolvers<RegisteredTool[]> | undefined;
  private exited: PromiseWithResolvers<null> | undefined;

  constructor(options: PluginHostOptions) {
    this.descriptor = options.descriptor;
    const pluginId = options.descriptor.manifest.name;
    if (!PLUGIN_ID_PATTERN.test(pluginId)) {
      throw new Error(
        `invalid plugin id ${JSON.stringify(pluginId)}: must match ${PLUGIN_ID_PATTERN}`,
      );
    }

    this.handlers = options.handlers;
    this.netDomains = [...options.netDomains];
    this.nodeExecutable = options.nodeExecutable ?? process.execPath;
    this.hardened = options.hardened ?? true;
    this.logger = options.logger ?? defaultLogger;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.shutdownTimeoutMs =
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.stateDir = path.join(os.tmpdir(), "paco-plugins", pluginId);
    this.rootDir = options.descriptor.rootDir;
    this.slots = options.descriptor.slots;

    // A grant can only ever be the intersection of what the plugin asked for
    // and what the operator agreed to. A plugin that quietly drops a
    // capability from its manifest in an update must lose it, even if a stale
    // consent row still lists it.
    const requested = new Set(options.descriptor.manifest.capabilities);
    const dropped = options.grantedCapabilities.filter(
      (capability) => !requested.has(capability),
    );
    if (dropped.length > 0) {
      this.logger({
        level: "warn",
        message: `plugin ${pluginId}: dropping granted capabilities absent from the manifest: ${dropped.join(", ")}`,
      });
    }
    this.granted = new Set(
      options.grantedCapabilities.filter((capability) =>
        requested.has(capability),
      ),
    );
  }

  get state(): PluginHostState {
    return this.currentState;
  }

  get pluginId(): string {
    return this.descriptor.manifest.name;
  }

  /** The plugin's only writable directory, also exposed to it as env. */
  get pluginStateDir(): string {
    return this.stateDir;
  }

  onCrash(callback: (error: string) => void): void {
    this.crashCallbacks.add(callback);
  }

  /**
   * Spawns the worker, sends `init`, and resolves once the worker answers
   * `ready`. Rejects — the one place the host does throw, because the
   * embedder asked for this plugin right now — if the handshake does not
   * arrive in time or the worker dies first.
   */
  async start(): Promise<{ tools: RegisteredTool[] }> {
    if (this.started) {
      throw new Error(`plugin ${this.pluginId} has already been started`);
    }
    this.started = true;
    this.currentState = "starting";

    await mkdir(this.stateDir, { recursive: true });
    try {
      this.assertWorkerScriptsExist();
      await this.assertRuntimeIsSupported();
      await this.resolveRealPaths();
      await this.assertPluginTreeIsContained();
    } catch (error) {
      // Refusing to start IS the containment here: there is no safe way to
      // run a plugin whose directory reaches outside itself.
      this.currentState = "crashed";
      throw error;
    }

    const child = spawn(this.nodeExecutable, this.buildWorkerArgs(), {
      // The plugin's own directory, so relative paths inside it resolve and
      // nothing above it is even nameable as `.`.
      cwd: this.rootDir,
      // Built from scratch. Never spread process.env: a plugin worker must
      // not inherit APP_SECRET, POSTGRES_URL, or any provider token.
      //
      // The double assertion is type-only: an embedder (Next.js) can
      // globally augment `NodeJS.ProcessEnv` to add a required `NODE_ENV`
      // field, which this object intentionally does not carry, so a plain
      // assertion doesn't typecheck once this package is consumed from such
      // an embedder. It changes nothing about the value actually spawned.
      env: {
        PATH: process.env.PATH ?? "",
        PACO_PLUGIN_ID: this.pluginId,
        PACO_PLUGIN_STATE_DIR: this.stateDir,
      } as unknown as NodeJS.ProcessEnv,
      // Its own process group, so a plugin that manages to spawn anything
      // has the whole tree killed with it rather than leaking orphans.
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    this.ready = Promise.withResolvers<RegisteredTool[]>();
    this.exited = Promise.withResolvers<null>();

    child.stdin.on("error", () => {
      // EPIPE on a worker that has already exited. The exit handler owns the
      // reporting; swallowing it here keeps the host process alive.
    });

    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_BYTES);
    });

    this.attachStdoutReader(child);

    child.on("error", (error: Error) => {
      this.handleTermination(
        `plugin ${this.pluginId} failed to spawn: ${error.message}`,
      );
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.handleTermination(
        `plugin ${this.pluginId} worker exited (code ${code}, signal ${signal})${
          this.stderrTail ? `: ${this.stderrTail.trim().slice(-1000)}` : ""
        }`,
      );
    });

    this.send({
      kind: "init",
      pluginId: this.pluginId,
      grantedCapabilities: [...this.granted],
      slots: this.slots,
    });

    const readyTimer = setTimeout(() => {
      this.forceCrash(
        `plugin ${this.pluginId} was not ready within ${this.readyTimeoutMs}ms`,
      );
    }, this.readyTimeoutMs);

    try {
      const tools = await this.ready.promise;
      this.currentState = "running";
      return { tools };
    } finally {
      clearTimeout(readyTimer);
    }
  }

  /**
   * Fire-and-forget session-event fan-out. Gated on `events:subscribe`: a
   * plugin without the grant is not merely ignored by the worker, it is
   * never sent the event.
   */
  deliverEvent(id: number, chatId: string, event: unknown): void {
    if (!this.granted.has("events:subscribe")) {
      return;
    }
    if (this.currentState !== "running") {
      return;
    }
    this.send({ kind: "event", id, chatId, event });
  }

  /**
   * Invokes a registered tool. Always resolves: a crash, a timeout, or a
   * thrown plugin error becomes `{ ok: false, error }` so the caller's turn
   * survives a broken plugin.
   */
  invokeTool(
    tool: string,
    input: unknown,
    timeoutMs: number = DEFAULT_TOOL_TIMEOUT_MS,
  ): Promise<ToolOutcome> {
    if (this.currentState !== "running") {
      return Promise.resolve({
        ok: false,
        error: `plugin ${this.pluginId} is not running (state: ${this.currentState})`,
      });
    }

    const callId = `${++this.callCounter}`;
    return new Promise<ToolOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(callId);
        // Tell the worker to stop: its AbortSignal fires, so a cooperative
        // tool releases whatever it was holding instead of running forever.
        this.send({ kind: "cancel-tool", callId });
        resolve({
          ok: false,
          error: `tool ${tool} timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);

      this.pendingCalls.set(callId, { resolve, timer });
      this.send({ kind: "invoke-tool", callId, tool, input });
    });
  }

  /**
   * Delivers one inbound channel webhook request to the worker and waits for
   * its `{status, body?}` answer.
   *
   * Gated on `channels:ingress`, checked here rather than left to the
   * generic `capability-request` path — an ingress delivery isn't a request
   * the worker *initiates*, so there's no `handleCapabilityRequest` call it
   * would otherwise pass through. A plugin whose grant doesn't (or no
   * longer) includes `channels:ingress` gets `reason: "not-granted"`
   * immediately, exactly like an ungranted capability elsewhere in this
   * class: never sent to the worker at all.
   *
   * Always resolves, never rejects — `IngressOutcome` carries every failure
   * mode (`not-granted`, `not-running`, `timeout`) as a value, the same
   * philosophy `invokeTool` uses for `ToolOutcome`, so a broken or slow
   * plugin degrades the one HTTP request touching it rather than throwing
   * into the route handler.
   */
  deliverIngress(
    channel: string,
    headers: Record<string, string>,
    body: unknown,
    rawBody: string,
    timeoutMs: number = DEFAULT_INGRESS_TIMEOUT_MS,
  ): Promise<IngressOutcome> {
    if (!this.granted.has("channels:ingress")) {
      return Promise.resolve({
        ok: false,
        reason: "not-granted",
        error: `plugin ${this.pluginId}: capability not granted: channels:ingress`,
      });
    }
    if (this.currentState !== "running") {
      return Promise.resolve({
        ok: false,
        reason: "not-running",
        error: `plugin ${this.pluginId} is not running (state: ${this.currentState})`,
      });
    }

    const requestId = `ingress-${++this.callCounter}`;
    return new Promise<IngressOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingIngress.delete(requestId);
        resolve({
          ok: false,
          reason: "timeout",
          error: `ingress to channel "${channel}" timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);

      this.pendingIngress.set(requestId, { resolve, timer });
      this.send({
        kind: "ingress",
        requestId,
        channel,
        headers,
        body,
        rawBody,
      });
    });
  }

  /**
   * Asks the worker to shut down, then kills its whole process group if it
   * does not. Never rejects: stopping a plugin that is already gone is
   * success. A plugin that crashed stays `"crashed"` — stopping the corpse
   * does not retroactively make the failure clean.
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.settleStoppedState();
      return;
    }

    this.stopping = true;
    if (this.currentState === "starting") {
      // Nothing is going to answer the handshake now.
      this.ready?.reject(
        new Error(`plugin ${this.pluginId} was stopped during startup`),
      );
    }
    this.send({ kind: "shutdown" });

    const forceKill = setTimeout(() => {
      this.logger({
        level: "warn",
        message: `plugin ${this.pluginId} ignored shutdown; killing its process group`,
      });
      this.killProcessTree("SIGKILL");
    }, this.shutdownTimeoutMs);

    try {
      await this.exited?.promise;
    } finally {
      clearTimeout(forceKill);
      this.settleStoppedState();
      this.closeReader();
    }
  }

  // --- internals ---------------------------------------------------------

  /**
   * Rewrites every path the worker will touch to its real path, before the
   * allowlist is built from them.
   *
   * This is load-bearing, not tidiness. Node's permission model matches the
   * path as given, and its ESM loader resolves a module's real path while
   * loading it — so importing `/var/.../tool.js` on macOS makes the loader
   * traverse the `/var` symlink and be denied, no matter how the plugin's own
   * directory is spelled in the allowlist. Handing the worker real paths from
   * the start means there is no symlink left to traverse.
   */
  private async resolveRealPaths(): Promise<void> {
    this.stateDir = await realpathOrSelf(this.stateDir);
    this.rootDir = await realpathOrSelf(this.rootDir);
    const slots = this.descriptor.slots;
    const resolveAll = (paths: string[]) =>
      Promise.all(paths.map((slotPath) => realpathOrSelf(slotPath)));
    const [tools, channels, skills, agents, renderers, hooks] =
      await Promise.all([
        resolveAll(slots.tools),
        resolveAll(slots.channels),
        resolveAll(slots.skills),
        resolveAll(slots.agents),
        resolveAll(slots.renderers),
        resolveAll(slots.hooks),
      ]);
    this.slots = { tools, channels, skills, agents, renderers, hooks };
  }

  /**
   * Refuses to spawn a worker whose scripts are not where the host thinks
   * they are.
   *
   * `resolvePluginHostDir` deliberately never throws — a `TypeError` at module
   * scope is what took `next build` down — so a layout it cannot describe
   * reaches this point as a plausible-looking path that is simply not there.
   * This is where that becomes an error, and it is thrown here rather than
   * left to `spawn` because a Node process asked to run a missing file exits
   * with a bare "Cannot find module", which names neither the plugin nor the
   * fix.
   */
  private assertWorkerScriptsExist(): void {
    const missing = [workerEntryPath, workerPreloadPath].filter(
      // `turbopackIgnore` for the same reason as `installedCopiesAbove`: these
      // paths are resolved at runtime, and without it Next's tracer gives up
      // and pulls the whole project into the NFT list.
      (script) => !existsSync(/* turbopackIgnore: true */ script),
    );
    if (missing.length > 0) {
      throw new Error(
        `plugin ${this.pluginId} cannot start: the plugin-host package files are not where they were expected (missing: ${missing.join(", ")}). This host resolved its own package directory to ${pluginHostDir}. Set ${PACKAGE_DIR_ENV} to the directory holding ${WORKER_ENTRY_FILENAME} and ${WORKER_PRELOAD_FILENAME}.`,
      );
    }
  }

  /**
   * Refuses to run a hardened worker on a runtime whose permission model does
   * not gate sockets.
   *
   * The check is on the binary that will actually be spawned, not on the
   * host's own runtime, because `nodeExecutable` is exactly the thing an
   * embedder gets wrong. Anything whose version cannot be read is refused too:
   * an unrecognized runtime is not evidence of a supported one.
   */
  private async assertRuntimeIsSupported(): Promise<void> {
    if (!this.hardened) {
      return;
    }
    const major = await detectRuntimeMajorVersion(this.nodeExecutable);
    const fix =
      `Point the \`nodeExecutable\` option at a Node >= ${MIN_HARDENED_NODE_MAJOR} binary ` +
      "(Paco's bundled Node satisfies this), or set `hardened: false` — which " +
      "removes the sandbox entirely and is only for this package's own tests.";
    const why =
      `Node >= ${MIN_HARDENED_NODE_MAJOR} gates network sockets in its permission model; ` +
      "older releases do not, which would leave the in-process module " +
      "allowlist as the only barrier between the plugin and the network.";

    if (major === undefined) {
      throw new Error(
        `plugin ${this.pluginId} cannot start: could not determine the version of the runtime at ${this.nodeExecutable}. A hardened plugin worker requires Node >= ${MIN_HARDENED_NODE_MAJOR}. ${why} ${fix}`,
      );
    }
    if (major < MIN_HARDENED_NODE_MAJOR) {
      throw new Error(
        `plugin ${this.pluginId} cannot start: the runtime at ${this.nodeExecutable} reports major version ${major}, but a hardened plugin worker requires Node >= ${MIN_HARDENED_NODE_MAJOR}. ${why} ${fix}`,
      );
    }
  }

  /**
   * Refuses to start a plugin whose directory can reach outside itself.  /**
   * Refuses to start a plugin whose directory can reach outside itself.
   *
   * Node's permission model allows a path prefix, and it FOLLOWS symlinks
   * that live under an allowed prefix. A plugin shipping `escape -> /` is
   * therefore granted the entire filesystem, read through its own directory:
   * verified reading `/etc/hosts`, Paco's own source, and the operator's home
   * directory on Node 26.7.0 with the allowlist correctly applied. The
   * allowlist cannot express "but not through links", so the check has to
   * happen here, before the worker exists.
   *
   * The installer rejects symlinked archives too; this is the defence in
   * depth that also covers a directory installed by hand or in dev.
   *
   * The scan is bounded in both breadth and depth, and exceeding either bound
   * is itself a refusal — an unbounded walk of an attacker-supplied directory
   * would just be a different denial of service.
   */
  private async assertPluginTreeIsContained(): Promise<void> {
    let entriesSeen = 0;

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_PLUGIN_DEPTH) {
        throw new Error(
          `plugin ${this.pluginId} nests directories deeper than ${MAX_PLUGIN_DEPTH}: ${dir}`,
        );
      }
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        entriesSeen++;
        if (entriesSeen > MAX_PLUGIN_ENTRIES) {
          throw new Error(
            `plugin ${this.pluginId} contains more than ${MAX_PLUGIN_ENTRIES} files`,
          );
        }
        // Dirent reflects lstat, so this is the link itself, not its target.
        if (entry.isSymbolicLink()) {
          throw new Error(
            `plugin ${this.pluginId} contains a symbolic link, which would read outside its own directory: ${entryPath}`,
          );
        }
        if (entry.isDirectory()) {
          await walk(entryPath, depth + 1);
        }
      }
    };

    await walk(this.rootDir, 0);

    // Belt and braces: every slot path, already resolved to its real path,
    // must still land inside the plugin's real root.
    const prefix = this.rootDir + path.sep;
    for (const slotPaths of Object.values(this.slots)) {
      for (const slotPath of slotPaths) {
        if (!slotPath.startsWith(prefix)) {
          throw new Error(
            `plugin ${this.pluginId} has a slot file outside its own directory: ${slotPath}`,
          );
        }
      }
    }
  }

  /**
   * The worker's command line. In hardened mode this is where containment
   * actually happens: an allow-list of readable paths, one writable path,
   * and the absence of `--allow-child-process` / `--allow-worker` /
   * `--allow-addons`.
   */
  private buildWorkerArgs(): string[] {
    const packageDir = realpathSyncOrSelf(pluginHostDir);
    return buildWorkerArgv({
      hardened: this.hardened,
      readableDirs: [
        this.rootDir,
        packageDir,
        this.stateDir,
        ...WORKER_RUNTIME_PACKAGES.map((specifier) =>
          realpathSyncOrSelf(resolvePackageDir(specifier, packageDir)),
        ),
      ],
      writableDir: this.stateDir,
      preloadPath: realpathSyncOrSelf(workerPreloadPath),
      entryPath: realpathSyncOrSelf(workerEntryPath),
    });
  }

  /**
   * Reads stdout through the capped line reader rather than `readline`, which
   * would happily accumulate a gigabyte waiting for a newline that never
   * arrives. The framing and its cap live in `line-reader.ts`, where the chunk
   * boundary is an argument a test can set — the bug this guards against was
   * only reachable on chunkings the host cannot arrange for itself.
   */
  private attachStdoutReader(child: ChildProcessWithoutNullStreams): void {
    const reader = readLines({
      onLine: (line) => this.onLine(line),
      onOverflow: (message) =>
        this.forceCrash(`plugin ${this.pluginId} ${message}`),
    });
    this.lineReader = reader;

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      if (this.readerClosed) {
        return;
      }
      reader.push(chunk);
    });
  }

  private send(message: HostToWorkerMessage): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) {
      return;
    }
    // A worker that died between the check and the write must not take the
    // host process down with an EPIPE; the exit handler reports the failure.
    stdin.write(encodeMessage(message), () => {
      // Write errors are reported by the stdin error handler set at spawn.
    });
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.countMalformed("worker wrote a line that is not JSON");
      return;
    }

    const message = workerToHostSchema.safeParse(parsed);
    if (!message.success) {
      this.countMalformed(
        "worker sent a message that failed schema validation",
      );
      return;
    }

    switch (message.data.kind) {
      case "ready":
        this.ready?.resolve(this.acceptRegisteredTools(message.data.tools));
        break;
      case "tool-result": {
        const pending = this.pendingCalls.get(message.data.callId);
        if (!pending) {
          break;
        }
        clearTimeout(pending.timer);
        this.pendingCalls.delete(message.data.callId);
        pending.resolve(
          message.data.ok
            ? { ok: true, output: message.data.output }
            : { ok: false, error: message.data.error ?? "tool failed" },
        );
        break;
      }
      case "capability-request":
        void this.handleCapabilityRequest(
          message.data.requestId,
          message.data.capability,
          message.data.payload,
        );
        break;
      case "ingress-result": {
        const pending = this.pendingIngress.get(message.data.requestId);
        if (!pending) {
          break;
        }
        clearTimeout(pending.timer);
        this.pendingIngress.delete(message.data.requestId);
        pending.resolve({
          ok: true,
          status: message.data.status,
          body: message.data.body,
        });
        break;
      }
      case "log":
        if (this.allowLog()) {
          this.logger({
            level: message.data.level,
            message: `plugin ${this.pluginId}: ${message.data.message}`,
          });
        }
        break;
      default:
        break;
    }
  }

  /**
   * Tools are a capability, not a freebie. A plugin that registers them
   * without `tools:register` has them dropped — otherwise the consent screen
   * would be describing a permission the host does not actually require.
   */
  private acceptRegisteredTools(tools: RegisteredTool[]): RegisteredTool[] {
    if (tools.length === 0 || this.granted.has("tools:register")) {
      return tools;
    }
    this.logger({
      level: "warn",
      message: `plugin ${this.pluginId}: dropping ${tools.length} registered tool(s): capability not granted: tools:register`,
    });
    return [];
  }

  /**
   * Token bucket over worker `log` messages. A plugin logging in a tight loop
   * would otherwise be a free write amplifier into the operator's log sink.
   */
  private allowLog(): boolean {
    const now = Date.now();
    if (now - this.logWindowStart >= 1000) {
      this.logWindowStart = now;
      this.logTokens = MAX_LOGS_PER_SECOND;
      this.logRateWarned = false;
    }
    if (this.logTokens > 0) {
      this.logTokens--;
      return true;
    }
    if (!this.logRateWarned) {
      this.logRateWarned = true;
      this.logger({
        level: "warn",
        message: `plugin ${this.pluginId}: log rate limit exceeded (${MAX_LOGS_PER_SECOND}/s); dropping messages`,
      });
    }
    return false;
  }

  /**
   * The security gate. Order matters: the grant is checked before the
   * handler is even looked up, so an ungranted capability cannot reach an
   * implementation no matter what the worker sends.
   *
   * Capability requests are answered during `"starting"` on purpose. Slot
   * loading legitimately needs them — a hook reads its stored state or
   * subscribes before the plugin is ready — and the handshake cannot complete
   * until slot loading does, so deferring them would deadlock `start()`. The
   * grant check is identical at every state, so nothing is weakened by it.
   * Once `stop()` has begun, requests are refused: teardown must not be able
   * to reach a handler.
   */
  private async handleCapabilityRequest(
    requestId: string,
    capability: Capability,
    payload: unknown,
  ): Promise<void> {
    if (
      this.stopping ||
      this.currentState === "stopped" ||
      this.currentState === "crashed"
    ) {
      this.send({
        kind: "capability-result",
        requestId,
        ok: false,
        error: "plugin is shutting down",
      });
      return;
    }

    if (!this.granted.has(capability)) {
      this.logger({
        level: "warn",
        message: `plugin ${this.pluginId}: capability not granted: ${capability}`,
      });
      this.send({
        kind: "capability-result",
        requestId,
        ok: false,
        error: `capability not granted: ${capability}`,
      });
      return;
    }

    if (capability === "net:fetch") {
      const denial = this.checkNetFetch(payload);
      if (denial) {
        this.logger({
          level: "warn",
          message: `plugin ${this.pluginId}: ${denial}`,
        });
        this.send({
          kind: "capability-result",
          requestId,
          ok: false,
          error: denial,
        });
        return;
      }
    }

    const handler = this.handlers[capability];
    if (!handler) {
      this.send({
        kind: "capability-result",
        requestId,
        ok: false,
        error: "capability not available",
      });
      return;
    }

    if (this.inFlightCapabilityRequests >= MAX_INFLIGHT_CAPABILITY_REQUESTS) {
      // Flooding the host with concurrent requests is a protocol violation,
      // not a workload: it counts against the same budget as garbage.
      this.countMalformed(
        `worker exceeded ${MAX_INFLIGHT_CAPABILITY_REQUESTS} in-flight capability requests`,
      );
      this.send({
        kind: "capability-result",
        requestId,
        ok: false,
        error: "capability request queue full",
      });
      return;
    }

    this.inFlightCapabilityRequests++;
    try {
      const value = await handler(this.pluginId, payload);
      this.send({ kind: "capability-result", requestId, ok: true, value });
    } catch (error) {
      this.send({
        kind: "capability-result",
        requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.inFlightCapabilityRequests--;
    }
  }

  /**
   * Enforces the operator's consented `netDomains` for `net:fetch`, in the
   * host, before the request can reach a handler. Returns the denial reason,
   * or `undefined` when the request is allowed.
   *
   * The list comes from `PluginHostOptions.netDomains` — the consent record —
   * never from `descriptor.manifest.netDomains`. See `checkFetchAllowed` for
   * the rules.
   *
   * **The handler must check again.** This gate sees a URL string; it cannot
   * see where the name resolves or where a redirect leads. The `net:fetch`
   * handler is required to fetch with `redirect: "manual"`, re-run
   * `isFetchAllowed` on every hop, and refuse when the resolved address is
   * private, loopback, or link-local (169.254.169.254 is the cloud metadata
   * endpoint). Without that, a consented domain is an SSRF gadget.
   */
  private checkNetFetch(payload: unknown): string | undefined {
    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof (payload as { url?: unknown }).url !== "string"
    ) {
      return "net:fetch denied: payload has no url";
    }

    const decision = checkFetchAllowed(
      (payload as { url: string }).url,
      this.netDomains,
    );
    return decision.allowed ? undefined : decision.reason;
  }

  /**
   * Protocol violations are counted, not tolerated indefinitely: a worker
   * spraying garbage is either broken or probing, and both end the same way.
   */
  private countMalformed(reason: string): void {
    if (this.crashReported || this.currentState === "stopped") {
      // Already dead. Lines still in the pipe are noise, not new violations.
      return;
    }
    this.malformedCount++;
    this.logger({
      level: "warn",
      message: `plugin ${this.pluginId}: ${reason} (${this.malformedCount}/${MAX_MALFORMED_MESSAGES})`,
    });
    if (this.malformedCount >= MAX_MALFORMED_MESSAGES) {
      this.forceCrash(
        `plugin ${this.pluginId} sent ${this.malformedCount} malformed messages`,
      );
    }
  }

  /**
   * Kills the worker's whole process group. `detached: true` at spawn made
   * the worker a group leader, so the negative pid reaches anything it
   * managed to start; the direct kill is the fallback for platforms or
   * timings where that fails.
   */
  private killProcessTree(signal: NodeJS.Signals): void {
    const child = this.child;
    if (!child?.pid) {
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Already reaped. Nothing left to kill.
      }
    }
  }

  private closeReader(): void {
    this.readerClosed = true;
    this.lineReader?.close();
  }

  private forceCrash(reason: string): void {
    this.closeReader();
    this.killProcessTree("SIGKILL");
    this.handleTermination(reason);
  }

  /** Single funnel for every way a worker can stop being usable. */
  private handleTermination(reason: string): void {
    this.exited?.resolve(null);

    if (this.stopping || this.currentState === "stopped") {
      this.settleStoppedState();
      return;
    }
    if (this.crashReported) {
      return;
    }
    this.crashReported = true;
    this.currentState = "crashed";

    this.logger({ level: "error", message: reason });
    this.ready?.reject(new Error(reason));
    this.settleAllPending(`plugin ${this.pluginId} crashed: ${reason}`);

    for (const callback of this.crashCallbacks) {
      try {
        callback(reason);
      } catch (error) {
        // A misbehaving crash listener must not become a second failure.
        this.logger({
          level: "error",
          message: `plugin ${this.pluginId}: onCrash listener threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }
  }

  /**
   * Moves to `"stopped"` unless the plugin already crashed. A crash is a
   * fact about the run and survives the cleanup that follows it.
   */
  private settleStoppedState(): void {
    if (this.currentState !== "crashed") {
      this.currentState = "stopped";
    }
    this.settleAllPending(
      `plugin ${this.pluginId} is not running (state: ${this.currentState})`,
    );
  }

  private settleAllPending(error: string): void {
    for (const [callId, pending] of this.pendingCalls) {
      clearTimeout(pending.timer);
      this.pendingCalls.delete(callId);
      pending.resolve({ ok: false, error });
    }
    for (const [requestId, pending] of this.pendingIngress) {
      clearTimeout(pending.timer);
      this.pendingIngress.delete(requestId);
      pending.resolve({ ok: false, reason: "not-running", error });
    }
  }
}

async function realpathOrSelf(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return target;
  }
}

const execFileAsync = promisify(execFile);

/**
 * Major version of a runtime binary, or `undefined` if it cannot be read.
 *
 * Cached per executable: a host that restarts plugins repeatedly should not
 * spawn a probe every time. Note that a non-Node runtime answers with its own
 * version — bun reports `1.x` — which fails the floor check, as it should.
 */
const runtimeMajorCache = new Map<string, number | undefined>();

async function detectRuntimeMajorVersion(
  executable: string,
): Promise<number | undefined> {
  const cached = runtimeMajorCache.get(executable);
  if (cached !== undefined || runtimeMajorCache.has(executable)) {
    return cached;
  }

  let major: number | undefined;
  try {
    const { stdout } = await execFileAsync(executable, ["-v"], {
      timeout: 10_000,
    });
    const match = /^v?(\d+)\./.exec(stdout.trim());
    major = match?.[1] === undefined ? undefined : Number(match[1]);
  } catch {
    major = undefined;
  }
  runtimeMajorCache.set(executable, major);
  return major;
}

/** Real path of `target`, or `target` itself when it cannot be resolved. */
function realpathSyncOrSelf(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * Absolute directory of a package the worker imports, found the way Node's
 * own resolver would: `node_modules/<specifier>` in each ancestor of the
 * directory doing the importing, nearest first.
 *
 * `from` is the worker entry's own directory, not this module's, because the
 * worker is what has to resolve these — and once bundled, this module has no
 * directory worth resolving from. That also retires the `createRequire`
 * this used to call: a `require.resolve` of a computed specifier is one of
 * the dynamic-resolution shapes that makes Turbopack's tracer fall back to
 * tracing the whole project, and Next only re-does the work of Node's
 * resolver here to reach an answer three lines of `path.join` already give.
 *
 * The result is left for the caller to `realpath`: pnpm's `node_modules`
 * entries are symlinks, and the permission model matches real paths.
 */
function resolvePackageDir(specifier: string, from: string): string {
  let dir = path.resolve(from);
  for (;;) {
    // `turbopackIgnore` for the same reason as `installedCopiesAbove`.
    const candidate = path.join(
      /* turbopackIgnore: true */ dir,
      "node_modules",
      ...specifier.split("/"),
    );
    if (existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `cannot locate ${specifier}, which the plugin worker must be able to read, in any node_modules above ${from}`,
      );
    }
    dir = parent;
  }
}

function defaultLogger(entry: HostLogEntry): void {
  const line = `[plugin-host] ${entry.message}`;
  if (entry.level === "error") {
    console.error(line);
  } else if (entry.level === "warn") {
    console.warn(line);
  } else {
    console.info(line);
  }
}
