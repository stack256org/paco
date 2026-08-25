/**
 * Stub ACP server fixture for acp-client.test.ts.
 *
 * Speaks the same newline-delimited JSON-RPC 2.0 framing as the real
 * `openfx acp` (PROTOCOL.md §2 — one JSON object per line, no
 * Content-Length framing) and implements the subset of the message catalog
 * (PROTOCOL.md §3) that AcpClient's tests exercise: `initialize`,
 * `session/new`, `session/load`, `session/prompt`, `session/cancel`, and the
 * server-initiated `session/request_permission` (PROTOCOL.md §5).
 *
 * What happens during `session/prompt` is entirely driven by a JSON
 * "script" (see `StubScript` below), passed either as `process.argv[2]` (a
 * path to a JSON file) or the `ACP_STUB_SCRIPT` env var (a path, or inline
 * JSON text) — so a test can control exactly which `session/update`
 * notifications stream back, in what order, and how slowly:
 *
 * - `ACP_STUB_SLOW=1` switches from `stepDelayMs` to `slowStepDelayMs`
 *   between steps, long enough that a client-sent `session/cancel` can land
 *   mid-turn (the point of the "cancel mid-turn" test).
 * - `ACP_STUB_HANG_ON_CLOSE=1` makes the process ignore stdin EOF instead of
 *   exiting, so a test can exercise AcpClient.close()'s SIGTERM escalation.
 * - `ACP_STUB_IGNORE_SIGTERM=1` additionally ignores SIGTERM, so a test can
 *   exercise the final SIGKILL fallback.
 */
import { existsSync, readFileSync } from "node:fs";
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
  | { kind: "update"; update: unknown }
  | { kind: "permission"; permission: ScriptedPermission }
  // Writes a raw, non-JSON line verbatim — used to test that AcpClient
  // skips malformed lines instead of failing the whole session.
  | { kind: "raw"; line: string }
  // Writes a single line of exactly `bytes` bytes (generated here, not
  // carried through ACP_STUB_SCRIPT, since an env var that large risks
  // hitting OS argument/environment size limits) — used to test that
  // AcpClient skips a line over PROTOCOL.md §2's 8MB frame limit instead
  // of trying to parse or buffer it.
  | { kind: "raw-oversized"; bytes: number };

interface StubScript {
  steps?: ScriptedStep[];
  stopReason?: string;
  /** ms between steps in normal mode. Default: no delay. */
  stepDelayMs?: number;
  /** ms between steps in slow mode (ACP_STUB_SLOW=1). Default: 200ms. */
  slowStepDelayMs?: number;
}

function loadScript(): StubScript {
  // Env var takes priority: AcpClient always puts "acp" (plus optional
  // --model/--log-file) in argv per PROTOCOL.md §1's real invocation, so
  // argv[2] is only trustworthy as a script source when it's an actual file
  // — never when it's just whatever positional argument AcpClient happened
  // to pass through.
  const envSource = process.env.ACP_STUB_SCRIPT;
  if (envSource !== undefined) {
    const text = existsSync(envSource)
      ? readFileSync(envSource, "utf-8")
      : envSource;
    return JSON.parse(text) as StubScript;
  }
  const argSource = process.argv[2];
  if (argSource && existsSync(argSource)) {
    return JSON.parse(readFileSync(argSource, "utf-8")) as StubScript;
  }
  return {};
}

const script = loadScript();
const slow = process.env.ACP_STUB_SLOW === "1";
const hangOnClose = process.env.ACP_STUB_HANG_ON_CLOSE === "1";
const ignoreSigterm = process.env.ACP_STUB_IGNORE_SIGTERM === "1";
const exitBeforeResponse = process.env.ACP_STUB_EXIT_BEFORE_RESPONSE === "1";

if (ignoreSigterm) {
  process.on("SIGTERM", () => {
    // Intentionally ignored — this is what forces a test's AcpClient.close()
    // to escalate all the way to SIGKILL.
  });
}

if (hangOnClose) {
  // Without this, Node's event loop would go empty and exit on its own the
  // moment stdin hits EOF, defeating the point of "hang on close" — the
  // test needs the process to only die from an actual signal.
  setInterval(() => {
    // No-op keep-alive tick.
  }, 1_000_000);
}

let sessionCounter = 0;
let cancelled = false;

function writeLine(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id: unknown, result: unknown): void {
  writeLine({ jsonrpc: "2.0", id, result });
}

function respondError(id: unknown, code: number, message: string): void {
  writeLine({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method: string, params: unknown): void {
  writeLine({ jsonrpc: "2.0", method, params });
}

function sendUpdate(sessionId: string, update: unknown): void {
  notify("session/update", { sessionId, update });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Permission requests use negative ids so they never collide with the
// positive ids AcpClient assigns its own outgoing requests.
let permissionRequestCounter = 0;
function nextPermissionRequestId(): number {
  permissionRequestCounter -= 1;
  return permissionRequestCounter;
}

const pendingPermissionResponses = new Map<
  number,
  (decision: unknown) => void
>();

function requestPermission(
  sessionId: string,
  permission: ScriptedPermission,
): Promise<unknown> {
  const id = nextPermissionRequestId();
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

async function runScriptedPrompt(sessionId: string): Promise<string> {
  const steps = script.steps ?? [];
  const delay = slow
    ? (script.slowStepDelayMs ?? 200)
    : (script.stepDelayMs ?? 0);

  for (const step of steps) {
    if (cancelled) {
      break;
    }
    if (delay > 0) {
      await sleep(delay);
    }
    if (cancelled) {
      break;
    }

    if (step.kind === "update") {
      sendUpdate(sessionId, step.update);
    } else if (step.kind === "permission") {
      const decision = await requestPermission(sessionId, step.permission);
      // Echoed back as an update so a test can assert the round trip
      // end-to-end, not just that the handler was invoked.
      sendUpdate(sessionId, { kind: "permission_echo", decision });
    } else if (step.kind === "raw") {
      process.stdout.write(`${step.line}\n`);
    } else {
      process.stdout.write(`${"x".repeat(step.bytes)}\n`);
    }
  }

  return cancelled ? "cancelled" : (script.stopReason ?? "end_turn");
}

function handleInitialize(id: unknown): void {
  respond(id, {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: false, audio: false, embeddedContext: true },
      mcpCapabilities: { http: true, sse: true },
      sessionCapabilities: { list: {}, resume: {}, close: {} },
    },
    agentInfo: { name: "fx", title: "fx", version: "0.0.0-stub" },
    authMethods: [],
  });
}

function handleNewSession(id: unknown): void {
  sessionCounter += 1;
  const sessionId = `stub-session-${sessionCounter}`;
  respond(id, {
    sessionId,
    configOptions: [],
    modes: { currentModeId: "default", availableModes: [] },
  });
  sendUpdate(sessionId, {
    kind: "available_commands_update",
    availableCommands: [],
  });
}

function handleLoadSession(id: unknown): void {
  respond(id, {
    configOptions: [],
    modes: { currentModeId: "default", availableModes: [] },
  });
}

function handlePrompt(id: unknown, params: unknown): void {
  if (exitBeforeResponse) {
    // Simulates the process dying mid-turn, before ever answering
    // session/prompt — proves AcpClient rejects the pending request instead
    // of hanging forever.
    process.exit(1);
  }
  const sessionId =
    isRecord(params) && typeof params.sessionId === "string"
      ? params.sessionId
      : "unknown";
  cancelled = false;
  runScriptedPrompt(sessionId).then((stopReason) => {
    respond(id, { stopReason });
  });
}

function handleCancel(id: unknown): void {
  cancelled = true;
  // PROTOCOL.md §3: sent as a notification (no `id`) or a request; a
  // request gets an immediate `null` without waiting for the turn to stop.
  if (id !== undefined) {
    respond(id, null);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
    // server-initiated requests (only session/request_permission, here).
    handleClientResponse(message);
    return;
  }

  switch (method) {
    case "initialize": {
      handleInitialize(id);
      return;
    }
    case "session/new": {
      handleNewSession(id);
      return;
    }
    case "session/load": {
      handleLoadSession(id);
      return;
    }
    case "session/prompt": {
      handlePrompt(id, params);
      return;
    }
    case "session/cancel": {
      handleCancel(id);
      return;
    }
    default: {
      if (id !== undefined) {
        respondError(id, -32_601, `Unsupported method: ${method}`);
      }
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
  // Mirrors PROTOCOL.md §4: the real server's read loop exits on stdin EOF.
  if (!hangOnClose) {
    process.exit(0);
  }
});
