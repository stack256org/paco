import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as path from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { Capability, PluginDescriptor } from "@paco/plugin-kit";
import { z } from "zod";
import {
  encodeMessage,
  type HostToWorkerMessage,
  type RegisteredTool,
  workerToHostSchema,
} from "./protocol.ts";

/** How many protocol violations a worker gets before the host kills it. */
const MAX_MALFORMED_MESSAGES = 5;
/** How long `start()` waits for the worker's `ready` handshake. */
const DEFAULT_READY_TIMEOUT_MS = 10_000;
/** Default ceiling on a single tool invocation. */
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
/** How long `stop()` waits after `shutdown` before SIGKILL. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3000;
/** Ceiling on retained worker stderr, so a chatty plugin cannot grow it. */
const MAX_STDERR_BYTES = 16_000;

/** Schemes a plugin may fetch. Anything else is a way out of the allowlist. */
const ALLOWED_FETCH_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * The only part of a `net:fetch` payload the host needs to police. Everything
 * else (method, headers, body) is the handler's concern.
 */
const fetchPayloadSchema = z.object({ url: z.string() });

/**
 * Absolute path to the worker entry script.
 *
 * Resolved from this file rather than from `process.cwd()`, because the host
 * runs inside a Next.js server whose working directory is not the package.
 */
export const workerEntryPath: string = path.join(
  import.meta.dirname,
  "worker-entry.ts",
);

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

export type PluginHostState = "starting" | "running" | "crashed" | "stopped";

export interface PluginHostOptions {
  descriptor: PluginDescriptor;
  /** Exactly what the operator consented to. Nothing else is enforced. */
  grantedCapabilities: Capability[];
  handlers: CapabilityHandlers;
  /** Production pins Paco's bundled node; defaults to `process.execPath`. */
  nodeExecutable?: string;
  logger?: HostLogger;
  readyTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

interface PendingToolCall {
  resolve: (outcome: ToolOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Runs one plugin in its own process and enforces its capability grant.
 *
 * Three invariants shape everything below:
 *
 * 1. The worker's environment is built from scratch. `process.env` holds the
 *    app secret, the database URL and every provider token; a plugin must
 *    never see them, so the env is `{ PATH, PACO_PLUGIN_ID }` and nothing
 *    more — not a filtered copy, a fresh object.
 * 2. Grant checks happen here, before any handler runs. The worker is
 *    untrusted code and can ask for anything; asking is not receiving.
 * 3. `net:fetch` is narrowed further, still in the host: the target must be
 *    http(s) and its hostname must match `manifest.netDomains` exactly. See
 *    `checkNetFetchAllowlist`.
 *
 * Background failures — a crash, a protocol violation, a hung tool — resolve
 * into values (`state`, `onCrash`, `ToolOutcome`) and are never thrown into
 * the embedder, because a broken plugin must degrade rather than fail a turn.
 */
export class PluginHost {
  private readonly descriptor: PluginDescriptor;
  private readonly granted: Set<Capability>;
  private readonly handlers: CapabilityHandlers;
  private readonly nodeExecutable: string;
  private readonly logger: HostLogger;
  private readonly readyTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;

  private child: ChildProcessWithoutNullStreams | undefined;
  private stdoutLines: Interface | undefined;
  private currentState: PluginHostState = "starting";
  private malformedCount = 0;
  private stderrTail = "";
  private stopping = false;
  private crashReported = false;
  private started = false;
  private callCounter = 0;

  private readonly crashCallbacks = new Set<(error: string) => void>();
  private readonly pendingCalls = new Map<string, PendingToolCall>();
  private ready: PromiseWithResolvers<RegisteredTool[]> | undefined;
  private exited: PromiseWithResolvers<null> | undefined;

  constructor(options: PluginHostOptions) {
    this.descriptor = options.descriptor;
    this.granted = new Set(options.grantedCapabilities);
    this.handlers = options.handlers;
    this.nodeExecutable = options.nodeExecutable ?? process.execPath;
    this.logger = options.logger ?? defaultLogger;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.shutdownTimeoutMs =
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }

  get state(): PluginHostState {
    return this.currentState;
  }

  get pluginId(): string {
    return this.descriptor.manifest.name;
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

    const child = spawn(this.nodeExecutable, [workerEntryPath], {
      // Built from scratch. Never spread process.env: a plugin worker must
      // not inherit APP_SECRET, POSTGRES_URL, or any provider token.
      env: {
        PATH: process.env.PATH ?? "",
        PACO_PLUGIN_ID: this.pluginId,
      },
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

    this.stdoutLines = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    this.stdoutLines.on("line", (line: string) => this.onLine(line));

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
      slots: this.descriptor.slots,
    });

    const readyTimer = setTimeout(() => {
      this.ready?.reject(
        new Error(
          `plugin ${this.pluginId} was not ready within ${this.readyTimeoutMs}ms`,
        ),
      );
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
   * Asks the worker to shut down, then kills it if it does not. Never
   * rejects: stopping a plugin that is already gone is success.
   */
  async stop(): Promise<void> {
    if (
      !this.child ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    ) {
      this.currentState = "stopped";
      this.settleAllPending(`plugin ${this.pluginId} stopped`);
      return;
    }

    this.stopping = true;
    const child = this.child;
    this.send({ kind: "shutdown" });

    const forceKill = setTimeout(() => {
      this.logger({
        level: "warn",
        message: `plugin ${this.pluginId} ignored shutdown; sending SIGKILL`,
      });
      child.kill("SIGKILL");
    }, this.shutdownTimeoutMs);

    try {
      await this.exited?.promise;
    } finally {
      clearTimeout(forceKill);
      this.currentState = "stopped";
      this.settleAllPending(`plugin ${this.pluginId} stopped`);
      this.stdoutLines?.close();
    }
  }

  // --- internals ---------------------------------------------------------

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
        this.ready?.resolve(message.data.tools);
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
      case "log":
        this.logger({
          level: message.data.level,
          message: `plugin ${this.pluginId}: ${message.data.message}`,
        });
        break;
      default:
        break;
    }
  }

  /**
   * The security gate. Order matters: the grant is checked before the
   * handler is even looked up, so an ungranted capability cannot reach an
   * implementation no matter what the worker sends.
   */
  private async handleCapabilityRequest(
    requestId: string,
    capability: Capability,
    payload: unknown,
  ): Promise<void> {
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
      const denial = this.checkNetFetchAllowlist(payload);
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
    }
  }

  /**
   * Enforces the manifest's `netDomains` allowlist for `net:fetch`, in the
   * host, before the request can reach a handler. Returns the denial reason,
   * or `undefined` when the request is allowed.
   *
   * The rules, in order:
   *
   * 1. The payload must carry a string `url`, and it must parse as an
   *    absolute URL. An unparsable target cannot be checked, so it is denied.
   * 2. The scheme must be `http:` or `https:`. `file:`, `data:` and friends
   *    have no hostname to match and would read the host filesystem.
   * 3. The hostname must be an EXACT, case-insensitive member of
   *    `manifest.netDomains`. There is no subdomain matching in either
   *    direction: a grant for `api.linear.app` covers neither
   *    `evil.api.linear.app` nor `linear.app`.
   * 4. An absent or empty `netDomains` denies everything. A manifest that
   *    requests `net:fetch` cannot validly omit it, so reaching this branch
   *    means the grant is unusable rather than unlimited.
   *
   * The web app's `net:fetch` handler checks the same list again. That is
   * deliberate: this is the first gate, not the only one.
   */
  private checkNetFetchAllowlist(payload: unknown): string | undefined {
    const parsed = fetchPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return "net:fetch denied: payload has no url";
    }

    let target: URL;
    try {
      target = new URL(parsed.data.url);
    } catch {
      return `net:fetch denied: unparsable url ${parsed.data.url}`;
    }

    if (!ALLOWED_FETCH_PROTOCOLS.has(target.protocol)) {
      return `net:fetch denied: scheme ${target.protocol} not allowed`;
    }

    const allowed = this.descriptor.manifest.netDomains ?? [];
    const hostname = target.hostname.toLowerCase();
    if (!allowed.some((domain) => domain.toLowerCase() === hostname)) {
      return `net:fetch denied: host ${hostname} not in netDomains`;
    }

    return undefined;
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

  private forceCrash(reason: string): void {
    this.child?.kill("SIGKILL");
    this.handleTermination(reason);
  }

  /** Single funnel for every way a worker can stop being usable. */
  private handleTermination(reason: string): void {
    this.exited?.resolve(null);

    if (this.stopping || this.currentState === "stopped") {
      this.currentState = "stopped";
      this.settleAllPending(`plugin ${this.pluginId} stopped`);
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

  private settleAllPending(error: string): void {
    for (const [callId, pending] of this.pendingCalls) {
      clearTimeout(pending.timer);
      this.pendingCalls.delete(callId);
      pending.resolve({ ok: false, error });
    }
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
