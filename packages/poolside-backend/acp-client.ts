import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { AcpError } from "./acp-error.ts";
import type {
  ConfigOption,
  InitializeParams,
  InitializeResult,
  LoadSessionParams,
  LoadSessionResult,
  NewSessionParams,
  NewSessionResult,
  PermissionDecision,
  PermissionHandler,
  PermissionRequestParams,
  PromptParams,
  PromptResult,
  SessionUpdateEnvelope,
  SystemPromptResult,
} from "./acp-types.ts";

/**
 * Transport for `pool acp` — Poolside's Agent Client Protocol server over
 * the child's stdio.
 *
 * Framing is newline-delimited JSON-RPC 2.0, one object per line; there is
 * no Content-Length framing. Requests correlate by id; `session/update`
 * notifications and `session/request_permission` requests are
 * server-initiated.
 *
 * Deliberately `pool acp` and not `pool acp serve`: the latter is the
 * network transport (Streamable HTTP / WebSocket). Plain `pool acp` is the
 * stdio one, which is what a per-turn child process wants.
 *
 * This module only speaks the wire. Mapping `session/update` payloads to
 * UI chunks is `chunk-mapper.ts`; implementing `AgentBackend` on top is
 * `backend.ts`.
 */

export { AcpError };

export interface AcpClientOptions {
  /**
   * Working directory the process is spawned with, and the `cwd` sent on
   * `session/new` / `session/load`.
   *
   * It is load-bearing beyond process cwd: `pool` inlines the `AGENTS.md`
   * found here into the agent's system prompt (verified — the fetched
   * prompt is 12517 chars in a repo with an AGENTS.md and 3198 in an empty
   * directory, the difference being an `<agents_md>` block quoting the file
   * verbatim). That is the ONLY system-prompt customization channel the CLI
   * has; see `PoolsideBackendOptions.systemContext`.
   */
  cwd: string;
  /** The `pool` binary. Defaults to `"pool"`, resolved on PATH. */
  executable?: string;
  /**
   * Extra argv inserted BEFORE the `acp` subcommand. Production never sets
   * this; tests point it at `test/stub-pool-acp.ts` via
   * `{executable: process.execPath, extraArgs: [stubPath]}`.
   */
  extraArgs?: string[];
  /** `pool acp --sandbox`. Left unset, the CLI's own sandbox configuration applies. */
  sandbox?: "required" | "disabled";
  /** `pool acp --settings` — a YAML file path, or inline YAML. */
  settings?: string;
  /**
   * Environment layered over a MINIMAL base (PATH, HOME, and
   * XDG_CONFIG_HOME when set); nothing else is inherited from the host.
   *
   * HOME is in the base because `pool` reads
   * `~/.config/poolside/credentials.json` for the signed-in session and
   * writes logs/trajectories under the user's data directory. Credentials
   * can also be supplied explicitly here as `POOLSIDE_API_KEY`, with
   * `POOLSIDE_STANDALONE_BASE_URL` selecting a different deployment — see
   * `buildPoolsideBackendConfig`.
   */
  env?: Record<string, string>;
  /**
   * How long `close()` waits at each escalation step. The CLI documents no
   * shutdown RPC, so shutdown is stdin EOF then SIGTERM then SIGKILL;
   * these are this client's own conservative defaults, present mainly so
   * tests can shrink them.
   */
  closeTimeoutsMs?: { graceful?: number; term?: number };
}

const DEFAULT_GRACEFUL_CLOSE_MS = 3000;
const DEFAULT_TERM_CLOSE_MS = 2000;
const STDERR_LIMIT = 64_000;
/** Caps the buffered-but-unconsumed `updates` backlog against a slow/absent consumer. */
const MAX_QUEUED_UPDATES = 10_000;
const MAX_INBOUND_LINE_BYTES = 8 * 1024 * 1024;

/** JSON-RPC's "method not found". */
const METHOD_NOT_FOUND = -32_601;
/** JSON-RPC's "internal error", used when a permission handler throws. */
const INTERNAL_ERROR = -32_603;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * A MINIMAL env for the spawned process: only what `pool` needs to exist at
 * all (PATH, to find the binary) and to find its own profile (HOME, and
 * XDG_CONFIG_HOME when the host sets one, for
 * `~/.config/poolside/credentials.json`). Everything else — the API key,
 * the base URL, a turn's `GH_TOKEN` — must be passed explicitly.
 */
function buildMinimalEnv(
  explicit: Record<string, string> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "XDG_CONFIG_HOME"]) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return { ...env, ...explicit };
}

/**
 * The wire form of an MCP server entry: `env` is an array of
 * `{name, value}`, not an object. `PoolsideMcpServer` takes the ergonomic
 * `Record` and this converts it, so no caller has to know.
 */
function toWireMcpServers(
  servers: NewSessionParams["mcpServers"],
): unknown[] | undefined {
  if (!servers) {
    return;
  }
  return servers.map((server) => ({
    name: server.name,
    command: server.command,
    args: server.args,
    env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
  }));
}

interface UpdateQueue<T> extends AsyncIterable<T> {
  push(item: T): void;
  /** Drop everything buffered but not yet consumed, leaving the queue open. */
  discardBuffered(): void;
  close(): void;
}

/**
 * A single-consumer async queue: pushed from the read loop, pulled by a
 * `for await`. A factory rather than a class so `AcpClient` stays this
 * file's only class.
 *
 * Bounded: a consumer that stops reading must not let this grow without
 * limit, so on overflow the oldest buffered update is dropped and exactly
 * one warning fires per overflow episode (the flag resets once a push lands
 * back under the cap).
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

    discardBuffered(): void {
      items.length = 0;
      overflowWarned = false;
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
 * Client for one `pool acp` process.
 *
 * `session/update` notifications are exposed as the `updates` async
 * iterable — matching this codebase's other streaming transports
 * (`ClaudeCodeRun.messages`, `TurnHandle.chunks`) rather than a callback.
 * It is SINGLE-consumer: exactly one `for await` should read it.
 */
export class AcpClient {
  /** The child process, exposed for diagnostics — mirrors `ClaudeCodeRun.process`. */
  readonly process: ChildProcessWithoutNullStreams;
  /** Every `session/update` notification, in order. Single-consumer. */
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
      ...(options.sandbox ? ["--sandbox", options.sandbox] : []),
      ...(options.settings ? ["--settings", options.settings] : []),
    ];

    this.closeTimeouts = {
      graceful: options.closeTimeoutsMs?.graceful ?? DEFAULT_GRACEFUL_CLOSE_MS,
      term: options.closeTimeoutsMs?.term ?? DEFAULT_TERM_CLOSE_MS,
    };

    // `turbopackIgnore` because both the executable and `options.cwd` are
    // runtime values Next's build-time file tracer cannot resolve
    // statically — the binary is looked up on PATH and the cwd is a
    // per-worktree directory. Without the hint the tracer decides this
    // module's trace is untrustworthy and falls back to tracing the whole
    // project, which is how `.next/standalone` ended up missing real
    // dependencies elsewhere in the build. Same note as `workspaceRoot()`
    // in packages/sandbox/docker/connect.ts.
    this.process = spawn(
      /* turbopackIgnore: true */ options.executable ?? "pool",
      args,
      {
        cwd: options.cwd,
        // Cast rather than widening `buildMinimalEnv`'s return type: Next's
        // `next/types/global.d.ts` augments the global `NodeJS.ProcessEnv`
        // with a REQUIRED `NODE_ENV`, and apps/web's TS program applies that
        // to every file it checks, including this one. This env is
        // deliberately minimal and must not gain a `NODE_ENV` key just to
        // satisfy an unrelated ambient type — `spawn()` has no runtime
        // requirement on it.
        env: buildMinimalEnv(options.env) as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ) as ChildProcessWithoutNullStreams;

    this.updates = this.updatesQueue;

    this.process.stderr.setEncoding("utf-8");
    this.process.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_LIMIT);
    });

    this.process.on("close", (code) => this.handleExit(code));
    this.process.on("error", (error) => this.handleSpawnError(error));
    // A write racing process teardown surfaces as an async 'error' on these
    // streams, not a throw, and Node crashes the host when an 'error' event
    // has no listener. These route it into the same cleanup path.
    this.process.stdin.on("error", (error) => this.handleStreamError(error));
    this.process.stdout.on("error", (error) => this.handleStreamError(error));

    this.readLoop().catch((error: unknown) => {
      this.handleStreamError(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  }

  /** Last 64k of the process's stderr, for diagnostics. */
  get stderr(): string {
    return this.stderrTail;
  }

  initialize(params: InitializeParams): Promise<InitializeResult> {
    return this.request<InitializeResult>("initialize", params);
  }

  /**
   * `session/new`. `configOptions` are sent as
   * `_meta["poolside/early_session_config_options"]` — the only way to pick
   * a model/thought level BEFORE the first prompt, since `session/new` has
   * no top-level slot for them.
   */
  newSession(params: NewSessionParams): Promise<NewSessionResult> {
    const { configOptions, mcpServers, ...rest } = params;
    return this.request<NewSessionResult>("session/new", {
      ...rest,
      ...(mcpServers ? { mcpServers: toWireMcpServers(mcpServers) } : {}),
      ...(configOptions && configOptions.length > 0
        ? { _meta: { "poolside/early_session_config_options": configOptions } }
        : {}),
    });
  }

  /**
   * `session/load`. Reattaches a NEW process to an existing conversation —
   * verified across processes, which is what makes `resume` honest.
   *
   * It replays the session's entire history as `session/update`
   * notifications (user_message_chunk, tool_call, agent_message_chunk,
   * usage_update, ...) BEFORE answering this request. `backend.ts` relies
   * on that ordering to discard the replay instead of re-emitting a whole
   * transcript into the UI.
   */
  loadSession(params: LoadSessionParams): Promise<LoadSessionResult> {
    const { mcpServers, ...rest } = params;
    return this.request<LoadSessionResult>("session/load", {
      ...rest,
      ...(mcpServers ? { mcpServers: toWireMcpServers(mcpServers) } : {}),
    });
  }

  prompt(params: PromptParams): Promise<PromptResult> {
    return this.request<PromptResult>("session/prompt", params);
  }

  /**
   * `session/set_config_option`. The parameter is `configId`, not `id` — an
   * `id` is rejected with `unknown config option`. Answers with the
   * session's refreshed `configOptions`.
   *
   * Used on RESUMED turns, where `session/load` takes no early options.
   */
  setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<{ configOptions?: ConfigOption[] }> {
    return this.request<{ configOptions?: ConfigOption[] }>(
      "session/set_config_option",
      { sessionId, configId, value },
    );
  }

  /**
   * Reads the agent's EFFECTIVE system prompt.
   *
   * This is what `initialize`'s `_meta["poolside/system_prompt"]` flag
   * actually advertises: a getter, for a client that wants to display the
   * prompt. It is NOT a setter — passing a `systemPrompt` here returns the
   * unchanged default. Exposed so a settings page can show the real prompt;
   * `PoolsideBackend` itself never calls it.
   */
  fetchSystemPrompt(sessionId: string): Promise<SystemPromptResult> {
    return this.request<SystemPromptResult>("_poolside/session_system_prompt", {
      sessionId,
    });
  }

  /**
   * Sends `session/cancel` as a notification.
   *
   * The running `session/prompt` still resolves — with
   * `stopReason: "end_turn"`, NOT `"cancelled"` (verified against the live
   * binary). A caller must therefore track cancellation itself; this method
   * rejects nothing.
   */
  cancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  /**
   * Drops every `session/update` buffered but not yet consumed.
   *
   * Exists for one specific, load-bearing case: `session/load` replays the
   * WHOLE conversation as `session/update` notifications before it answers.
   * Those are history, not this turn's output, and re-emitting them would
   * duplicate an entire transcript into the chat. Because the read loop
   * parses lines in order, every replayed notification is already buffered
   * by the time the `session/load` response is handled — so calling this
   * immediately after that response resolves discards exactly the replay
   * and nothing else.
   *
   * Safe only while nothing is consuming `updates`; `PoolsideBackend` holds
   * its chunk stream back until this has run.
   */
  discardBufferedUpdates(): void {
    this.updatesQueue.discardBuffered();
  }

  /** Registers the handler for server-initiated `session/request_permission`. */
  onPermissionRequest(handler: PermissionHandler): void {
    this.permissionHandler = handler;
  }

  /**
   * Ends the process: stdin EOF first (the CLI's read loop exits on it),
   * escalating to SIGTERM and then SIGKILL if it doesn't leave on its own.
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
   * Resolves `true` once the process exits, `false` after `timeoutMs`. Two
   * independent single-resolution promises raced: whichever settles first
   * leaves the other's listener/timer to fire later as a harmless no-op.
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
        new AcpError("Poolside ACP process has already exited"),
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
      // Already gone (or going): a write here would no-op against a
      // destroyed stream or surface later as an async 'error', so skip it
      // rather than race teardown.
      return;
    }
    try {
      this.process.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // A broken pipe normally arrives as the stream's 'error' event
      // (handled in the constructor), but guard here too so a write racing
      // teardown can never crash the host.
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
          console.warn(
            `AcpClient: skipped an inbound line over ${MAX_INBOUND_LINE_BYTES} bytes.`,
          );
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          // A non-JSON stdout line: skipped, mirroring
          // packages/claude-code/run.ts, rather than failing the session.
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
    // Poolside also emits `_poolside/compaction_update` and
    // `_poolside/show_message` notifications. Neither has a consumer at the
    // transport layer, so they are dropped rather than buffered.
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
    // Anything else gets method_not_found rather than being left to hang.
    // `pool` can also send `_poolside/elicitation` and
    // `_poolside/mcp/authenticate`; both are interactive flows this
    // headless client has no way to answer, so declining is the honest
    // response.
    this.respondError(
      id,
      METHOD_NOT_FOUND,
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
        this.respondError(id, INTERNAL_ERROR, message);
      });
  }

  private handleExit(code: number | null): void {
    const stderr = this.stderrTail.trim().slice(-2000);
    this.terminate(
      new AcpError(
        `Poolside ACP process exited before responding (code ${code})${
          stderr ? `: ${stderr}` : ""
        }`,
      ),
    );
  }

  private handleSpawnError(error: Error): void {
    this.terminate(
      new AcpError(`Failed to spawn Poolside ACP process: ${error.message}`),
    );
  }

  private handleStreamError(error: Error): void {
    this.terminate(
      new AcpError(`Poolside ACP process stream error: ${error.message}`),
    );
  }

  /**
   * The single teardown path shared by every way the transport can die (a
   * clean or unclean exit, a spawn failure, an async stream error): marks
   * the client dead, rejects every still-pending request, and closes the
   * `updates` queue so its consumer's `for await` ends instead of hanging.
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
