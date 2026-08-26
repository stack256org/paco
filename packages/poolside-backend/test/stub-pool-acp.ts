/**
 * Stub `pool acp` server for this package's tests.
 *
 * Speaks the same newline-delimited JSON-RPC 2.0 framing as the real
 * binary — one JSON object per line, no Content-Length — and implements the
 * subset of Poolside's message catalog the backend actually uses:
 * `initialize`, `session/new`, `session/load`, `session/prompt`,
 * `session/cancel`, `session/set_config_option`, and the server-initiated
 * `session/request_permission`.
 *
 * It reproduces two Poolside behaviours that a generic ACP stub would get
 * wrong, and that the backend exists to absorb:
 *
 * 1. A cancelled `session/prompt` answers `stopReason: "end_turn"` — NOT
 *    `"cancelled"` — and omits `usage` entirely. (Set
 *    `POOL_STUB_CANCEL_STOP_REASON` to override, for the day a release
 *    starts reporting it properly.)
 * 2. `session/load` REPLAYS the whole conversation as `session/update`
 *    notifications before it answers, so a resumed turn's stream would
 *    duplicate the transcript if the backend didn't discard them.
 *
 * What a prompt does is driven by a JSON script in `POOL_STUB_SCRIPT` (a
 * path, or inline JSON). Env switches:
 *
 * - `POOL_STUB_PID_FILE=<path>` writes this process's pid on startup, so a
 *   test can assert the process really died rather than only that `result`
 *   rejected.
 * - `POOL_STUB_RECORD_FILE=<path>` appends one JSON line per inbound
 *   request (`{method, params}`), preceded by a `{"method":"__spawn","env":…}`
 *   line carrying this process's environment and argv — which is how a test
 *   asserts what went out on the wire and what env the child was given,
 *   neither of which the backend exposes to its caller.
 * - `POOL_STUB_HANG_ON_CLOSE=1` ignores stdin EOF, so a test can exercise
 *   `AcpClient.close()`'s SIGTERM escalation.
 *
 * A step's own `delayMs` overrides the script-level `stepDelayMs`, and any
 * delay is interruptible by `session/cancel` — so a "hold the turn open"
 * script can stream one chunk immediately and then wait, and a cancel lands
 * at once instead of after the full delay.
 */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";

interface ScriptedPermission {
  toolCall: {
    toolCallId: string;
    title: string;
    kind: string;
    status: "pending";
    rawInput: unknown;
  };
  options: Array<{ optionId: string; name: string; kind: string }>;
}

type ScriptedStep =
  | { kind: "update"; update: unknown; delayMs?: number }
  | { kind: "permission"; permission: ScriptedPermission; delayMs?: number };

interface StubScript {
  steps?: ScriptedStep[];
  stopReason?: string;
  /** The `usage` a COMPLETED prompt answers with. Omitted on a cancelled one. */
  usage?: Record<string, number>;
  /** `_meta["poolside/task_outcome"]` on a completed prompt. */
  taskOutcome?: { success: boolean };
  /** ms between steps. Default: none. */
  stepDelayMs?: number;
  /** Updates `session/load` replays before answering — the history. */
  replay?: unknown[];
}

function loadScript(): StubScript {
  const source = process.env.POOL_STUB_SCRIPT;
  if (source === undefined) {
    return {};
  }
  const text = existsSync(source) ? readFileSync(source, "utf-8") : source;
  return JSON.parse(text) as StubScript;
}

const script = loadScript();
const hangOnClose = process.env.POOL_STUB_HANG_ON_CLOSE === "1";
const pidFile = process.env.POOL_STUB_PID_FILE;
const recordFile = process.env.POOL_STUB_RECORD_FILE;
const cancelStopReason = process.env.POOL_STUB_CANCEL_STOP_REASON ?? "end_turn";
/** Makes every `session/set_config_option` fail, the way an option or value the CLI does not know does. */
const rejectConfig = process.env.POOL_STUB_REJECT_CONFIG === "1";

if (pidFile) {
  writeFileSync(pidFile, String(process.pid), "utf-8");
}

function record(entry: Record<string, unknown>): void {
  if (!recordFile) {
    return;
  }
  appendFileSync(recordFile, `${JSON.stringify(entry)}\n`, "utf-8");
}

record({ method: "__spawn", env: process.env, argv: process.argv.slice(2) });

if (hangOnClose) {
  // Without this the event loop empties and the process exits the moment
  // stdin hits EOF, defeating the point: the test needs it to die only
  // from an actual signal.
  setInterval(() => {
    // No-op keep-alive tick.
  }, 1_000_000);
}

let sessionCounter = 0;
let cancelled = false;
/**
 * Resolved by `handleCancel` for the in-flight prompt, so a long per-step
 * delay is interrupted the moment `session/cancel` arrives instead of only
 * being noticed once it elapses.
 */
let cancelSignal: {
  promise: Promise<undefined>;
  resolve: (value: undefined) => void;
} | null = null;

/** The config options a session currently holds, keyed by configId. */
const sessionConfig = new Map<string, Map<string, string>>();

const DEFAULT_CONFIG: ReadonlyArray<[string, string]> = [
  ["mode", "default"],
  ["agent_mode", "build"],
  ["thought_level", "max"],
  ["model", "poolside/laguna-s-2.1"],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function writeLine(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id: unknown, result: unknown): void {
  writeLine({ jsonrpc: "2.0", id, result });
}

function respondError(id: unknown, code: number, message: string): void {
  writeLine({ jsonrpc: "2.0", id, error: { code, message } });
}

function sendUpdate(sessionId: string, update: unknown): void {
  writeLine({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `sleep`, resolved early if `session/cancel` arrives first. */
function sleepInterruptible(ms: number): Promise<void> {
  const signal = cancelSignal;
  if (!signal) {
    return sleep(ms);
  }
  return Promise.race([sleep(ms), signal.promise]);
}

function configOptionsFor(sessionId: string): unknown[] {
  const current =
    sessionConfig.get(sessionId) ?? new Map<string, string>(DEFAULT_CONFIG);
  return [...current].map(([id, currentValue]) => ({
    id,
    name: id,
    category: id,
    type: "select",
    currentValue,
    options: [{ name: currentValue, value: currentValue }],
  }));
}

// Permission requests use negative ids so they never collide with the
// positive ids AcpClient assigns its own outgoing requests.
let permissionRequestCounter = 0;
const pendingPermissionResponses = new Map<
  number,
  (decision: unknown) => void
>();

function requestPermission(
  sessionId: string,
  permission: ScriptedPermission,
): Promise<unknown> {
  permissionRequestCounter -= 1;
  const id = permissionRequestCounter;
  return new Promise((resolve) => {
    pendingPermissionResponses.set(id, resolve);
    writeLine({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: permission.toolCall,
        options: permission.options,
      },
    });
  });
}

async function runScriptedPrompt(sessionId: string): Promise<void> {
  const steps = script.steps ?? [];
  const delay = script.stepDelayMs ?? 0;

  for (const step of steps) {
    if (cancelled) {
      return;
    }
    const stepDelay = step.delayMs ?? delay;
    if (stepDelay > 0) {
      await sleepInterruptible(stepDelay);
    }
    if (cancelled) {
      return;
    }

    if (step.kind === "update") {
      sendUpdate(sessionId, step.update);
    } else {
      const decision = await requestPermission(sessionId, step.permission);
      sendUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `[permission:${JSON.stringify(decision)}]`,
        },
      });
    }
  }
}

function handleInitialize(id: unknown): void {
  // The real 1.0.16 handshake, trimmed to what the client reads.
  respond(id, {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true },
      mcpCapabilities: {},
      sessionCapabilities: { close: {}, delete: {}, list: {} },
      _meta: {
        "poolside/service_mode": "provider: stub.invalid",
        "poolside/session_steer": true,
        "poolside/system_prompt": true,
      },
    },
    agentInfo: { name: "pool-acp", title: "Poolside", version: "0.0.0-stub" },
    authMethods: [],
  });
}

function applyEarlyConfigOptions(sessionId: string, params: unknown): void {
  const config = new Map<string, string>(DEFAULT_CONFIG);
  sessionConfig.set(sessionId, config);
  const meta = isRecord(params) ? params._meta : undefined;
  const early = isRecord(meta)
    ? meta["poolside/early_session_config_options"]
    : undefined;
  if (!Array.isArray(early)) {
    return;
  }
  for (const option of early) {
    if (
      isRecord(option) &&
      typeof option.configId === "string" &&
      typeof option.value === "string"
    ) {
      config.set(option.configId, option.value);
    }
  }
}

function handleNewSession(id: unknown, params: unknown): void {
  sessionCounter += 1;
  const sessionId = `stub-session-${sessionCounter}`;
  applyEarlyConfigOptions(sessionId, params);
  // The real server emits this alongside a new session.
  sendUpdate(sessionId, {
    sessionUpdate: "available_commands_update",
    availableCommands: [],
  });
  respond(id, { sessionId, configOptions: configOptionsFor(sessionId) });
}

function handleLoadSession(id: unknown, params: unknown): void {
  const sessionId =
    isRecord(params) && typeof params.sessionId === "string"
      ? params.sessionId
      : "unknown";
  sessionConfig.set(sessionId, new Map<string, string>(DEFAULT_CONFIG));
  // Replay the conversation BEFORE responding — the real ordering, and the
  // whole reason the backend discards buffered updates at this point.
  for (const update of script.replay ?? []) {
    sendUpdate(sessionId, update);
  }
  respond(id, { configOptions: configOptionsFor(sessionId) });
}

function handleSetConfigOption(id: unknown, params: unknown): void {
  if (
    !(
      isRecord(params) &&
      typeof params.sessionId === "string" &&
      typeof params.configId === "string" &&
      typeof params.value === "string"
    )
  ) {
    respondError(id, -32_602, "Invalid params");
    return;
  }
  const config =
    sessionConfig.get(params.sessionId) ??
    new Map<string, string>(DEFAULT_CONFIG);
  if (rejectConfig || !config.has(params.configId)) {
    respondError(id, -32_603, "unknown config option");
    return;
  }
  config.set(params.configId, params.value);
  sessionConfig.set(params.sessionId, config);
  respond(id, { configOptions: configOptionsFor(params.sessionId) });
}

function handlePrompt(id: unknown, params: unknown): void {
  const sessionId =
    isRecord(params) && typeof params.sessionId === "string"
      ? params.sessionId
      : "unknown";
  cancelled = false;
  cancelSignal = Promise.withResolvers<undefined>();
  runScriptedPrompt(sessionId).then(() => {
    if (cancelled) {
      // Poolside's real quirk: a cancelled prompt reports an ordinary stop
      // reason and no usage at all.
      respond(id, { stopReason: cancelStopReason });
      return;
    }
    respond(id, {
      stopReason: script.stopReason ?? "end_turn",
      ...(script.usage ? { usage: script.usage } : {}),
      _meta: {
        "poolside/task_outcome": script.taskOutcome ?? { success: true },
      },
    });
  });
}

function handleCancel(id: unknown): void {
  cancelled = true;
  cancelSignal?.resolve(undefined);
  if (id !== undefined) {
    respond(id, null);
  }
}

function handleClientResponse(message: Record<string, unknown>): void {
  const { id } = message;
  if (typeof id !== "number") {
    return;
  }
  const resolve = pendingPermissionResponses.get(id);
  if (!resolve) {
    return;
  }
  pendingPermissionResponses.delete(id);
  resolve(message.result);
}

function handle(message: Record<string, unknown>): void {
  const { id, method, params } = message;

  if (typeof method !== "string") {
    // No `method` means this is a response to one of our own
    // server-initiated requests (only session/request_permission here).
    handleClientResponse(message);
    return;
  }
  record({ method, params });

  switch (method) {
    case "initialize":
      handleInitialize(id);
      return;
    case "session/new":
      handleNewSession(id, params);
      return;
    case "session/load":
      handleLoadSession(id, params);
      return;
    case "session/set_config_option":
      handleSetConfigOption(id, params);
      return;
    case "session/prompt":
      handlePrompt(id, params);
      return;
    case "session/cancel":
      handleCancel(id);
      return;
    default:
      if (id !== undefined) {
        respondError(id, -32_601, `Unsupported method: ${method}`);
      }
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  let message: unknown;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (isRecord(message)) {
    handle(message);
  }
});

rl.on("close", () => {
  // The real server's read loop exits on stdin EOF.
  if (!hangOnClose) {
    process.exit(0);
  }
});
