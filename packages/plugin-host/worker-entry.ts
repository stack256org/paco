/**
 * The entry point of a plugin worker process.
 *
 * This file is a *spawn target*, not a module anyone imports: the host runs
 * it with `spawn(nodeExecutable, [workerEntryPath])` and talks to it over
 * newline-delimited JSON on stdin/stdout. It is deliberately absent from
 * index.ts so nothing can accidentally load plugin code in-process.
 *
 * Nothing in here decides what a plugin may do. Capability calls become
 * `capability-request` messages and the host answers them; the worker only
 * ever learns the answer.
 */
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { Capability } from "@paco/plugin-kit";
import type {
  PluginApi,
  PluginFetchRequest,
  PluginFetchResponse,
  PluginHookModule,
  PluginSessionEvent,
  PluginToolModule,
} from "./plugin-api.ts";
import {
  encodeMessage,
  hostToWorkerSchema,
  type PluginSlots,
  type RegisteredTool,
  type WorkerToHostMessage,
} from "./protocol.ts";

/**
 * stdout is the protocol channel. A plugin that calls `console.log` would
 * otherwise inject a malformed line into it — which the host counts as a
 * protocol violation and eventually kills the worker for. Send every console
 * write to stderr instead, where the host reads it as bounded diagnostics.
 */
function redirectConsoleToStderr(): void {
  const toStderr = (...args: unknown[]) => {
    process.stderr.write(`${args.map(String).join(" ")}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  console.error = toStderr;
  console.debug = toStderr;
}

function send(message: WorkerToHostMessage): void {
  process.stdout.write(encodeMessage(message));
}

const pendingCapabilityCalls = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

const eventSubscribers = new Set<(event: PluginSessionEvent) => void>();
const tools = new Map<string, PluginToolModule>();
/** Abort controllers for tool calls still running, keyed by callId. */
const inFlightToolCalls = new Map<string, AbortController>();

let pluginId = "";
let requestCounter = 0;

/** Issues one capability request and waits for the host's verdict. */
function requestCapability(
  capability: Capability,
  payload: unknown,
): Promise<unknown> {
  const requestId = `${++requestCounter}`;
  return new Promise<unknown>((resolve, reject) => {
    pendingCapabilityCalls.set(requestId, { resolve, reject });
    send({ kind: "capability-request", requestId, capability, payload });
  });
}

const api: PluginApi = {
  get pluginId() {
    return pluginId;
  },
  get stateDir() {
    return process.env.PACO_PLUGIN_STATE_DIR ?? "";
  },
  fetch: (request: PluginFetchRequest) =>
    requestCapability("net:fetch", request) as Promise<PluginFetchResponse>,
  kv: {
    get: (key: string) => requestCapability("storage:kv", { op: "get", key }),
    set: async (key: string, value: unknown) => {
      await requestCapability("storage:kv", { op: "set", key, value });
    },
    delete: async (key: string) => {
      await requestCapability("storage:kv", { op: "delete", key });
    },
    list: async (prefix?: string) => {
      const keys = await requestCapability("storage:kv", {
        op: "list",
        prefix,
      });
      return Array.isArray(keys) ? keys.map(String) : [];
    },
  },
  postMessage: (message) => requestCapability("messages:post", message),
  events: {
    subscribe(callback) {
      eventSubscribers.add(callback);
      return () => eventSubscribers.delete(callback);
    },
  },
  panel: (payload) => requestCapability("ui:panel", payload),
  log(level, message) {
    send({ kind: "log", level, message });
  },
};

function isToolModule(value: unknown): value is PluginToolModule {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<PluginToolModule>;
  return (
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    typeof candidate.execute === "function"
  );
}

async function loadDefaultExport(filePath: string): Promise<unknown> {
  const loaded: unknown = await import(pathToFileURL(filePath).href);
  if (typeof loaded === "object" && loaded !== null && "default" in loaded) {
    return (loaded as { default: unknown }).default;
  }
  return undefined;
}

/**
 * Registers every `tools/*` default export. A slot file that fails to load
 * is reported and skipped: one broken tool must not stop the plugin from
 * registering the rest.
 */
async function loadTools(slots: PluginSlots): Promise<RegisteredTool[]> {
  const registered: RegisteredTool[] = [];
  for (const filePath of slots.tools) {
    try {
      const slotModule = await loadDefaultExport(filePath);
      if (!isToolModule(slotModule)) {
        api.log("warn", `tool slot ${filePath} has no valid default export`);
        continue;
      }
      tools.set(slotModule.name, slotModule);
      registered.push({
        name: slotModule.name,
        description: slotModule.description ?? "",
        inputSchema: slotModule.inputSchema ?? {},
      });
    } catch (error) {
      api.log("error", `failed to load tool ${filePath}: ${describe(error)}`);
    }
  }
  return registered;
}

/**
 * Runs every `hooks/*` default export with the capability api. A hook that
 * throws — including one that awaits a capability the operator never granted
 * — is logged and skipped so the plugin still reaches ready.
 */
async function loadHooks(slots: PluginSlots): Promise<void> {
  for (const filePath of slots.hooks) {
    try {
      const slotModule = await loadDefaultExport(filePath);
      if (typeof slotModule !== "function") {
        api.log(
          "warn",
          `hook slot ${filePath} has no default-exported function`,
        );
        continue;
      }
      await (slotModule as PluginHookModule)(api);
    } catch (error) {
      api.log("error", `hook ${filePath} failed: ${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolves once `init` has finished loading slots. Tool invocations and
 * event fan-out wait on it; capability results never do, because a slot
 * loading during init may itself be awaiting one.
 */
let initialized = new Promise<void>(() => {
  // Replaced by handleInit; until then, nothing that needs slots proceeds.
});

async function handleInit(message: {
  pluginId: string;
  grantedCapabilities: Capability[];
  slots: PluginSlots;
}): Promise<void> {
  pluginId = message.pluginId;
  const loading = (async () => {
    const registered = await loadTools(message.slots);
    await loadHooks(message.slots);
    return registered;
  })();
  initialized = loading.then(() => {
    // Slot loading is complete; queued work may proceed.
  });
  send({ kind: "ready", tools: await loading });
}

async function handleInvokeTool(message: {
  callId: string;
  tool: string;
  input: unknown;
}): Promise<void> {
  const tool = tools.get(message.tool);
  if (!tool) {
    send({
      kind: "tool-result",
      callId: message.callId,
      ok: false,
      error: `unknown tool: ${message.tool}`,
    });
    return;
  }

  const controller = new AbortController();
  inFlightToolCalls.set(message.callId, controller);
  try {
    const output = await tool.execute(message.input, api, controller.signal);
    send({ kind: "tool-result", callId: message.callId, ok: true, output });
  } catch (error) {
    send({
      kind: "tool-result",
      callId: message.callId,
      ok: false,
      error: describe(error),
    });
  } finally {
    inFlightToolCalls.delete(message.callId);
  }
}

/**
 * The host has given up on a call. Abort the signal handed to `execute` so a
 * cooperative tool can stop; the result, if one still arrives, is ignored by
 * the host because it has already settled that callId.
 */
function handleCancelTool(message: { callId: string }): void {
  const controller = inFlightToolCalls.get(message.callId);
  if (!controller) {
    return;
  }
  inFlightToolCalls.delete(message.callId);
  controller.abort(new Error("cancelled by host: the call timed out"));
}

function handleCapabilityResult(message: {
  requestId: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}): void {
  const pending = pendingCapabilityCalls.get(message.requestId);
  if (!pending) {
    return;
  }
  pendingCapabilityCalls.delete(message.requestId);
  if (message.ok) {
    pending.resolve(message.value);
  } else {
    pending.reject(new Error(message.error ?? "capability request failed"));
  }
}

function handleEvent(message: {
  id: number;
  chatId: string;
  event: unknown;
}): void {
  const payload: PluginSessionEvent = {
    id: message.id,
    chatId: message.chatId,
    event: message.event,
  };
  for (const subscriber of eventSubscribers) {
    try {
      subscriber(payload);
    } catch (error) {
      api.log("error", `event subscriber failed: ${describe(error)}`);
    }
  }
}

async function handleLine(line: string): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    api.log("error", "host sent a line that is not JSON");
    return;
  }

  const message = hostToWorkerSchema.safeParse(parsed);
  if (!message.success) {
    api.log("error", "host sent a message that failed schema validation");
    return;
  }

  switch (message.data.kind) {
    case "init":
      await handleInit(message.data);
      break;
    case "invoke-tool": {
      const invoke = message.data;
      await initialized;
      await handleInvokeTool(invoke);
      break;
    }
    case "capability-result":
      handleCapabilityResult(message.data);
      break;
    case "event": {
      const event = message.data;
      await initialized;
      handleEvent(event);
      break;
    }
    case "cancel-tool":
      handleCancelTool(message.data);
      break;
    case "shutdown":
      process.exit(0);
      break;
    default:
      break;
  }
}

function main(): void {
  redirectConsoleToStderr();

  // Plugin code that throws asynchronously must not take the worker down
  // silently: report it and keep serving the host.
  process.on("uncaughtException", (error: unknown) => {
    api.log("error", `uncaught exception: ${describe(error)}`);
  });
  process.on("unhandledRejection", (reason: unknown) => {
    api.log("error", `unhandled rejection: ${describe(reason)}`);
  });

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // Lines are dispatched concurrently on purpose. Serializing them would
  // deadlock: a tool awaiting a capability blocks until the host answers,
  // and that answer arrives as the very next line.
  lines.on("line", (line: string) => {
    handleLine(line).catch((error: unknown) => {
      api.log("error", `message handling failed: ${describe(error)}`);
    });
  });
  lines.on("close", () => {
    process.exit(0);
  });
}

main();
