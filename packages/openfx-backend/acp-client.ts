import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { AcpError } from "./acp-error.ts";

/**
 * Transport for the OpenFX ACP server, `openfx acp` (PROTOCOL.md §1-§5).
 *
 * Framing is newline-delimited JSON-RPC 2.0 over the child's stdio, not
 * Content-Length framing (PROTOCOL.md §2). Request/response correlation is
 * by JSON-RPC id; `session/update` notifications and `session/request_permission`
 * requests are server-initiated (PROTOCOL.md §3).
 *
 * Mapping ACP `session/update` payloads to UIMessageChunks (Task 3's
 * chunk-mapper.ts) and implementing AgentBackend on top of this transport
 * (Task 4) both live in later files — this module only speaks the wire
 * protocol.
 */

export { AcpError };

/** initialize params — PROTOCOL.md §3 row "initialize". */
export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities: {
    fs: { readTextFile: boolean; writeTextFile: boolean };
    terminal: boolean;
  };
}

/**
 * initialize result. PROTOCOL.md notes elicitation capabilities exist in the
 * real params/result but doesn't pin down their shape from source, so they
 * are omitted here rather than guessed (RESEARCH-FIRST rule).
 */
export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: {
    loadSession: boolean;
    promptCapabilities: {
      image: boolean;
      audio: boolean;
      embeddedContext: boolean;
    };
    mcpCapabilities: { http: boolean; sse: boolean };
    sessionCapabilities: {
      list: Record<string, never>;
      resume: Record<string, never>;
      close: Record<string, never>;
    };
  };
  agentInfo: { name: string; title: string; version: string };
  authMethods: unknown[];
}

/**
 * MCP server entry (PROTOCOL.md §7 "capabilities().mcp" row). Stdio requires
 * an absolute `command` path server-side; the remote variants are the only
 * two `initialize` actually advertises via `mcpCapabilities`, despite stdio
 * also being accepted (documented asymmetry, PROTOCOL.md §7).
 */
export type McpServerConfig =
  | {
      type?: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

export interface NewSessionParams {
  mcpServers?: McpServerConfig[];
}

export interface SessionModes {
  currentModeId: string;
  availableModes: unknown[];
}

/**
 * `configOptions` is documented only as "[provider?, model, mode]" — the
 * per-entry shape isn't pinned down in PROTOCOL.md, so it's passed through
 * as `unknown[]` rather than guessed.
 */
export interface NewSessionResult {
  sessionId: string;
  configOptions: unknown[];
  modes: SessionModes;
}

export interface LoadSessionParams {
  sessionId: string;
  mcpServers?: McpServerConfig[];
}

/** No `sessionId` in the response body — PROTOCOL.md §3 row "session/load". */
export interface LoadSessionResult {
  configOptions: unknown[];
  modes: SessionModes;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "resource"; resource: { uri: string; text?: string } }
  // Rejected server-side (error.UnsupportedPromptImage) per PROTOCOL.md §3;
  // kept in the union for type-level completeness of the documented shape.
  | { type: "image" };

export interface PromptParams {
  sessionId: string;
  prompt: ContentBlock[];
  _meta?: { fx?: { continueRecovery?: boolean } };
}

export type StopReason =
  | "end_turn"
  | "max_output_tokens"
  | "max_model_turns"
  | "refused"
  | "cancelled";

export interface PromptResult {
  stopReason: StopReason;
}

/**
 * One `session/update` notification (PROTOCOL.md §3). The `update` payload's
 * kind-specific shape (`agent_message_chunk`, `tool_call`,
 * `tool_call_update`, `available_commands_update`, `session_info_update`,
 * ...) is passed through verbatim: mapping it to UIMessageChunks is Task 3's
 * concern (chunk-mapper.ts), mirroring how @paco/agent-backend's
 * `assistant/chunk` event stores its wide-union payload as `unknown`.
 */
export interface SessionUpdateEnvelope {
  sessionId: string;
  update: unknown;
}

/** `session/request_permission` params — PROTOCOL.md §5, real field names. */
export interface PermissionRequestParams {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    title: string;
    kind: string;
    status: "pending";
    rawInput: unknown;
  };
  options: Array<{ optionId: string; name: string; kind: string }>;
}

export type PermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export interface PermissionDecision {
  outcome: PermissionOutcome;
}

/**
 * Answers a server-initiated `session/request_permission`. Returning (or
 * resolving to) a decision is the client's ordinary JSON-RPC response
 * (PROTOCOL.md §5); throwing responds with a JSON-RPC error instead.
 */
export type PermissionHandler = (
  request: PermissionRequestParams,
) => Promise<PermissionDecision> | PermissionDecision;

export interface AcpClientOptions {
  /**
   * Working directory the process is spawned with. Bound once, at
   * `initialize` time, to the workspace root the ACP server serves for its
   * whole lifetime — one process per workspace (PROTOCOL.md §1).
   */
  cwd: string;
  /** Real invocation is the `openfx` binary (PROTOCOL.md §1). */
  executable?: string;
  /**
   * Extra argv inserted BEFORE the "acp" subcommand and its flags. Real
   * usage never needs this; tests use it to point the spawn at
   * test/stub-acp-server.ts, e.g.
   * `{ executable: process.execPath, extraArgs: [stubPath] }`.
   */
  extraArgs?: string[];
  /** `--model` flag (PROTOCOL.md §1 `parseAcpArgs`). */
  model?: string;
  /** `--log-file` flag (PROTOCOL.md §1 `parseAcpArgs`). */
  logFile?: string;
  /**
   * Provider/credential env vars layered on top of a MINIMAL base (PATH,
   * HOME) — nothing else is inherited from the host process. See
   * PROTOCOL.md §1 "Provider / credential environment variables":
   * `OPENFX_MODEL`, `VERCEL_OIDC_TOKEN`, `AI_GATEWAY_API_KEY`,
   * `OLLAMA_API_KEY`, `OPENFX_SECRET_STORE`, `OPENFX_DISABLE_KEYCHAIN`, or a
   * `HOME` override all go here explicitly.
   */
  env?: Record<string, string>;
  /**
   * How long `close()` waits after each escalation step before trying the
   * next. PROTOCOL.md §4 documents no shutdown RPC and no shutdown timeout
   * at all — these defaults are this client's own conservative choice, not
   * a protocol requirement, and exist mainly so tests can shrink them.
   */
  closeTimeoutsMs?: { graceful?: number; term?: number };
}

const DEFAULT_GRACEFUL_CLOSE_MS = 3000;
const DEFAULT_TERM_CLOSE_MS = 2000;
const STDERR_LIMIT = 64_000;
/** Caps the buffered-but-unconsumed `updates` backlog against a slow/absent consumer. */
const MAX_QUEUED_UPDATES = 10_000;
/** Mirrors the server's own frame cap (PROTOCOL.md §2 `frame_resource_byte_limit`). */
const MAX_INBOUND_LINE_BYTES = 8 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * A MINIMAL env for the spawned process: nothing is inherited from the host
 * except what the process needs to exist at all (PATH, to locate the
 * `openfx` binary via exec search) and to find its own profile (HOME, read
 * pervasively for `~/.openfx` credentials/session store — PROTOCOL.md §1).
 * Everything else PROTOCOL.md documents as a provider/credential variable
 * must be passed explicitly through `options.env`.
 */
function buildMinimalEnv(
  explicit: Record<string, string> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  const path = process.env.PATH;
  const home = process.env.HOME;
  if (path !== undefined) {
    env.PATH = path;
  }
  if (home !== undefined) {
    env.HOME = home;
  }
  return { ...env, ...explicit };
}

interface UpdateQueue<T> extends AsyncIterable<T> {
  push(item: T): void;
  close(): void;
}

/**
 * A single-consumer async queue: push from the read loop, pull from
 * `for await`. A factory function, not a class, so `AcpClient` remains the
 * only class this file needs.
 *
 * Bounded at `MAX_QUEUED_UPDATES`: a consumer that stops reading `updates`
 * (or falls behind) must not let this queue grow without limit. On
 * overflow the oldest buffered update is dropped to make room for the new
 * one, and exactly one `console.warn` fires per overflow "episode" — the
 * warning flag resets as soon as a push lands while the queue is back
 * under the cap, so a queue that overflows, drains, and overflows again
 * warns once for each episode rather than either staying silent forever or
 * warning on every single dropped item.
 */
function createUpdateQueue<T>(): UpdateQueue<T> {
  const items: T[] = [];
  const waiting: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;
  let overflowWarned = false;

  return {
    push(item: T): void {
      if (closed) {
        return;
      }
      const resolve = waiting.shift();
      if (resolve) {
        resolve({ value: item, done: false });
        return;
      }
      if (items.length >= MAX_QUEUED_UPDATES) {
        items.shift();
        if (!overflowWarned) {
          overflowWarned = true;
          console.warn(
            `AcpClient: update queue exceeded ${MAX_QUEUED_UPDATES} entries; dropping the oldest buffered update. The consumer of \`updates\` is falling behind.`,
          );
        }
      } else {
        overflowWarned = false;
      }
      items.push(item);
    },

    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      for (const resolve of waiting.splice(0)) {
        resolve({ value: undefined as unknown as T, done: true });
      }
    },

    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next: (): Promise<IteratorResult<T>> => {
          if (items.length > 0) {
            const value = items.shift() as T;
            return Promise.resolve({ value, done: false });
          }
          if (closed) {
            return Promise.resolve({
              value: undefined as unknown as T,
              done: true,
            });
          }
          return new Promise((resolve) => {
            waiting.push(resolve);
          });
        },
      };
    },
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Client for one `openfx acp` process (PROTOCOL.md §1: one process serves
 * exactly one workspace root for its whole lifetime).
 *
 * The subscription for `session/update` notifications is the `updates`
 * async iterable (documented choice, over a callback, to match this
 * codebase's other streaming transports — `ClaudeCodeRun.messages`,
 * `TurnHandle.chunks`). It is single-consumer: only one `for await` loop
 * should read it.
 */
export class AcpClient {
  /** Underlying process, exposed for diagnostics — mirrors `ClaudeCodeRun.process`. */
  readonly process: ChildProcessWithoutNullStreams;
  /** Every `session/update` notification, in order. See class doc for consumption rules. */
  readonly updates: AsyncIterable<SessionUpdateEnvelope>;

  private readonly pending = new Map<number, PendingRequest>();
  private readonly updatesQueue = createUpdateQueue<SessionUpdateEnvelope>();
  private readonly closeTimeouts: { graceful: number; term: number };
  private nextRequestId = 1;
  private permissionHandler: PermissionHandler | undefined;
  private stderrTail = "";
  private exited = false;

  constructor(options: AcpClientOptions) {
    const args = [
      ...(options.extraArgs ?? []),
      "acp",
      ...(options.model ? ["--model", options.model] : []),
      ...(options.logFile ? ["--log-file", options.logFile] : []),
    ];

    this.closeTimeouts = {
      graceful: options.closeTimeoutsMs?.graceful ?? DEFAULT_GRACEFUL_CLOSE_MS,
      term: options.closeTimeoutsMs?.term ?? DEFAULT_TERM_CLOSE_MS,
    };

    // `turbopackIgnore` because both the executable and `options.cwd` are
    // runtime values Next's build-time file tracer cannot resolve
    // statically — the binary is looked up on PATH and the cwd is a
    // per-workspace directory. Without the hint the tracer decides this
    // module's trace is untrustworthy and falls back to tracing the entire
    // project, which is how `.next/standalone` ended up missing real
    // dependencies (`drizzle-orm`, `postgres`) elsewhere in the build. Same
    // note as `workspaceRoot()` in packages/sandbox/docker/connect.ts and
    // the PATH lookup in apps/web/lib/github/gh-installed.ts; see
    // apps/web/next.config.ts for the full investigation.
    this.process = spawn(
      /* turbopackIgnore: true */ options.executable ?? "openfx",
      args,
      {
        cwd: options.cwd,
        // Cast, not a widened return type on `buildMinimalEnv`: Next.js's
        // own `next/types/global.d.ts` augments the global `NodeJS.ProcessEnv`
        // with a required `NODE_ENV: 'development' | 'production' | 'test'`
        // field. `apps/web`'s TS program picks that up for every file it
        // typechecks, including this one, so `spawn()`'s `env` overload sees
        // a stricter `ProcessEnv` here than `@paco/openfx-backend`'s own
        // isolated tsconfig ever does. This env is deliberately minimal
        // (PATH/HOME plus explicit provider vars, see `buildMinimalEnv`) and
        // must NOT gain a `NODE_ENV` key just to satisfy that unrelated
        // ambient type — Node's `spawn()` has no runtime requirement on it.
        // The object is a valid runtime env either way; only the
        // compile-time shape differs by which program is doing the checking.
        env: buildMinimalEnv(options.env) as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ) as ChildProcessWithoutNullStreams;

    this.updates = this.updatesQueue;

    this.process.stderr.setEncoding("utf-8");
    this.process.stderr.on("data", (chunk: string) => {
      // Bounded so a chatty process can't grow this without limit.
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_LIMIT);
    });

    this.process.on("close", (code) => this.handleExit(code));
    // Surfaces spawn failures (e.g. missing binary) the same way run.ts does.
    this.process.on("error", (error) => this.handleSpawnError(error));
    // A write racing process teardown (e.g. cancel() right after the child
    // dies) surfaces as an async 'error' on these streams, not a thrown
    // exception. Node throws by default when an 'error' event has no
    // listener, so these exist purely to route that into the same cleanup
    // path instead of crashing the host.
    this.process.stdin.on("error", (error) => this.handleStreamError(error));
    this.process.stdout.on("error", (error) => this.handleStreamError(error));

    this.readLoop().catch((error: unknown) => {
      // A stream error the loop itself couldn't recover from: same cleanup
      // as any other unexpected teardown, instead of an unhandled rejection.
      this.handleStreamError(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  }

  /** Last 64k of stderr the process has written, for diagnostics. */
  get stderr(): string {
    return this.stderrTail;
  }

  initialize(params: InitializeParams): Promise<InitializeResult> {
    return this.request<InitializeResult>("initialize", params);
  }

  newSession(params: NewSessionParams = {}): Promise<NewSessionResult> {
    return this.request<NewSessionResult>("session/new", params);
  }

  loadSession(params: LoadSessionParams): Promise<LoadSessionResult> {
    return this.request<LoadSessionResult>("session/load", params);
  }

  prompt(params: PromptParams): Promise<PromptResult> {
    return this.request<PromptResult>("session/prompt", params);
  }

  /**
   * Sends `session/cancel` as a notification (PROTOCOL.md §3: it may be a
   * notification or a request; as a request the server answers `null`
   * immediately without waiting for the turn to actually stop, so a
   * notification carries the same information with less ceremony). The
   * running `session/prompt` still resolves normally, with
   * `stopReason: "cancelled"` (PROTOCOL.md §7 interrupt row) — this method
   * does not itself reject anything.
   */
  cancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  /** Registers the handler for server-initiated `session/request_permission`. */
  onPermissionRequest(handler: PermissionHandler): void {
    this.permissionHandler = handler;
  }

  /**
   * Ends the process: closes stdin (the documented clean shutdown — PROTOCOL.md
   * §4 says no shutdown RPC exists and the read loop exits on stdin EOF),
   * then escalates to SIGTERM and finally SIGKILL if the process doesn't
   * exit on its own.
   */
  async close(): Promise<void> {
    if (this.hasExited()) {
      return;
    }
    this.process.stdin.end();
    if (await this.waitForExit(this.closeTimeouts.graceful)) {
      return;
    }
    if (this.hasExited()) {
      return;
    }
    this.process.kill("SIGTERM");
    if (await this.waitForExit(this.closeTimeouts.term)) {
      return;
    }
    if (this.hasExited()) {
      return;
    }
    this.process.kill("SIGKILL");
    await this.waitForExit(this.closeTimeouts.term);
  }

  private hasExited(): boolean {
    return this.process.exitCode !== null || this.process.signalCode !== null;
  }

  /**
   * Resolves `true` once the process exits, or `false` after `timeoutMs`.
   * Two independent single-resolution promises raced together, rather than
   * one promise resolved from two event callbacks: whichever settles first
   * leaves the other's listener/timer to fire later as a harmless no-op
   * against an already-settled promise.
   */
  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.hasExited()) {
      return Promise.resolve(true);
    }
    return Promise.race([
      this.waitForCloseEvent(),
      this.waitForTimeout(timeoutMs),
    ]);
  }

  private waitForCloseEvent(): Promise<boolean> {
    return new Promise((resolve) => {
      this.process.once("close", () => resolve(true));
    });
  }

  private waitForTimeout(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      setTimeout(() => resolve(this.hasExited()), timeoutMs);
    });
  }

  private request<TResult>(method: string, params?: unknown): Promise<TResult> {
    if (this.exited) {
      return Promise.reject(
        new AcpError("OpenFX ACP process has already exited"),
      );
    }
    const id = this.nextRequestId++;
    const { promise, resolve, reject } = Promise.withResolvers<TResult>();
    this.pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    this.writeLine({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  private notify(method: string, params?: unknown): void {
    this.writeLine({ jsonrpc: "2.0", method, params });
  }

  private respond(id: number | string, result: unknown): void {
    this.writeLine({ jsonrpc: "2.0", id, result });
  }

  private respondError(
    id: number | string,
    code: number,
    message: string,
  ): void {
    this.writeLine({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private writeLine(message: Record<string, unknown>): void {
    if (this.exited) {
      // The process is already gone (or going): a write here would either
      // no-op against a destroyed stream or surface later as an async
      // 'error' event, so skip it outright rather than racing teardown.
      return;
    }
    try {
      this.process.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // Node normally reports a broken pipe via the stream's 'error' event
      // (handled in the constructor), not a synchronous throw, but guard
      // here too so a write racing process teardown can never crash the
      // host.
    }
  }

  private async readLoop(): Promise<void> {
    const rl = createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity,
    });
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        if (Buffer.byteLength(trimmed, "utf-8") > MAX_INBOUND_LINE_BYTES) {
          // Mirrors PROTOCOL.md §2: the real server caps a single frame at
          // 8MB and reports oversized frames as a protocol error rather
          // than parsing them. The client-side equivalent is simply to
          // never attempt to parse/hold onto a line this large.
          console.warn(
            `AcpClient: skipped an inbound line over ${MAX_INBOUND_LINE_BYTES} bytes (PROTOCOL.md §2 frame_resource_byte_limit).`,
          );
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          // Malformed line: skip, mirroring packages/claude-code/run.ts's
          // tolerance for a non-JSON stdout line rather than failing the
          // whole session.
          continue;
        }

        if (isRecord(parsed)) {
          this.handleMessage(parsed);
        }
      }
    } finally {
      rl.close();
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    const { id, method } = message;
    if (typeof method === "string") {
      if (typeof id === "number" || typeof id === "string") {
        this.handleServerRequest(id, method, message.params);
      } else {
        this.handleNotification(method, message.params);
      }
      return;
    }
    if (typeof id === "number") {
      this.handleResponse(id, message);
    }
  }

  private handleResponse(id: number, message: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);

    const error = message.error;
    if (isRecord(error)) {
      const code = typeof error.code === "number" ? error.code : undefined;
      const errorMessage =
        typeof error.message === "string"
          ? error.message
          : "ACP request failed";
      pending.reject(new AcpError(errorMessage, code, error.data));
      return;
    }
    pending.resolve(message.result);
  }

  private handleNotification(method: string, params: unknown): void {
    // `elicitation/complete` and anything else (PROTOCOL.md §3) has no
    // consumer at the transport layer yet — dropped rather than buffered.
    if (
      method === "session/update" &&
      isRecord(params) &&
      typeof params.sessionId === "string"
    ) {
      this.updatesQueue.push({
        sessionId: params.sessionId,
        update: params.update,
      });
    }
  }

  private handleServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): void {
    if (method === "session/request_permission") {
      this.handlePermissionRequest(id, params);
      return;
    }
    // PROTOCOL.md §3 lists only session/request_permission as a
    // server-to-client request; anything else gets method_not_found rather
    // than being left to hang forever.
    this.respondError(
      id,
      -32_601,
      `Unsupported server-initiated method: ${method}`,
    );
  }

  private handlePermissionRequest(id: number | string, params: unknown): void {
    const request = params as PermissionRequestParams;
    const handler = this.permissionHandler;
    const decision: Promise<PermissionDecision> = handler
      ? Promise.resolve(handler(request))
      : Promise.resolve({ outcome: { outcome: "cancelled" } });

    decision
      .then((result) => this.respond(id, result))
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : "permission handler failed";
        this.respondError(id, -32_603, message);
      });
  }

  private handleExit(code: number | null): void {
    const stderr = this.stderrTail.trim().slice(-2000);
    this.terminate(
      new AcpError(
        `OpenFX ACP process exited before responding (code ${code})${
          stderr ? `: ${stderr}` : ""
        }`,
      ),
    );
  }

  private handleSpawnError(error: Error): void {
    this.terminate(
      new AcpError(`Failed to spawn OpenFX ACP process: ${error.message}`),
    );
  }

  private handleStreamError(error: Error): void {
    this.terminate(
      new AcpError(`OpenFX ACP process stream error: ${error.message}`),
    );
  }

  /**
   * Single teardown path shared by every way the process/transport can die
   * (a clean or unclean exit, a spawn failure, an async stream error):
   * marks the client dead, rejects every still-pending request with the
   * given `AcpError`, and closes the `updates` queue so its consumer's
   * `for await` ends instead of hanging forever.
   */
  private terminate(error: AcpError): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    for (const [requestId, pendingRequest] of this.pending) {
      pendingRequest.reject(error);
      this.pending.delete(requestId);
    }
    this.updatesQueue.close();
  }
}
