#!/usr/bin/env node
/**
 * Standalone MCP server that bridges plugin-registered tools to the agent.
 *
 * Claude Code spawns this over stdio (per `--mcp-config`) and speaks
 * JSON-RPC 2.0 to it, one message per line (the MCP stdio transport). It
 * never talks to the plugin host or the database directly: it only knows
 * the flattened tool list handed to it via `PACO_PLUGIN_TOOLS`, and forwards
 * every `tools/call` to Paco's own internal route
 * (`app/api/internal/plugin-tools/route.ts`), which is the process that
 * actually holds the running `PluginHost` registry.
 *
 * Plain, dependency-free code with no imports beyond Node's own built-ins:
 * it runs as its own process, spawned by the CLI, not from the bundled app,
 * so it cannot rely on anything Next.js or a bundler provides.
 *
 * No top-level `function`/`var` declarations (only `const`/`let`), and
 * string concatenation instead of template literals: this file is embedded
 * as a plain string in `mcp-bridge.ts`, and a template literal's
 * interpolation syntax inside that embedded string reads to a linter as an
 * unresolved placeholder. A top-level `function` would otherwise leak onto
 * the global object once this file is spawned as a script rather than
 * imported.
 *
 * This file is the readable, lintable, type-checked copy.
 * `PLUGIN_MCP_SERVER_SOURCE` in `lib/plugins/mcp-bridge.ts` is the copy that
 * actually runs — the same reason the `PreToolUse` hook is embedded in
 * `packages/claude-code/approval.ts` rather than referenced by path: a
 * bundler rewrites `import.meta.url`, so a real path on disk cannot be
 * derived from it at runtime. `mcp-bridge.test.ts` fails if the two drift.
 */

type JsonRpcId = string | number | null;

type ToolEntry = {
  pluginId: string;
  name: string;
  description: string;
  inputSchema: unknown;
};

type ToolOutcome = { ok: true; output: unknown } | { ok: false; error: string };

const INTERNAL_URL = process.env.PACO_INTERNAL_URL ?? "";
const INTERNAL_TOKEN = process.env.PACO_INTERNAL_TOKEN ?? "";
const TOOLS_JSON = process.env.PACO_PLUGIN_TOOLS ?? "[]";

const PROTOCOL_VERSION = "2024-11-05";
/** Joins a plugin id and its tool name into the name exposed over MCP. */
const NAME_SEPARATOR = "__";
const TOOL_CALL_TIMEOUT_MS = 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Never throws: malformed or missing input just yields no tools. */
const parseToolEntries = (json: string): ToolEntry[] => {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) {
    return [];
  }

  const entries: ToolEntry[] = [];
  for (const item of raw) {
    if (
      isRecord(item) &&
      typeof item.pluginId === "string" &&
      typeof item.name === "string"
    ) {
      entries.push({
        pluginId: item.pluginId,
        name: item.name,
        description:
          typeof item.description === "string" ? item.description : "",
        inputSchema: item.inputSchema,
      });
    }
  }
  return entries;
};

const tools = parseToolEntries(TOOLS_JSON);

const toolFullName = (entry: ToolEntry): string =>
  entry.pluginId + NAME_SEPARATOR + entry.name;

const findTool = (fullName: string): ToolEntry | undefined =>
  tools.find((entry) => toolFullName(entry) === fullName);

const writeMessage = (message: Record<string, unknown>): void => {
  process.stdout.write(JSON.stringify(message) + "\n");
};

const respondResult = (id: JsonRpcId | undefined, result: unknown): void => {
  if (id === undefined || id === null) {
    return;
  }
  writeMessage({ jsonrpc: "2.0", id, result });
};

const respondError = (
  id: JsonRpcId | undefined,
  code: number,
  message: string,
): void => {
  if (id === undefined || id === null) {
    return;
  }
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
};

const isToolOutcome = (value: unknown): value is ToolOutcome => {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return false;
  }
  return value.ok ? "output" in value : typeof value.error === "string";
};

/** Forwards one tool call to Paco's internal route. Never throws. */
const callTool = async (
  entry: ToolEntry,
  input: unknown,
): Promise<ToolOutcome> => {
  try {
    const response = await fetch(INTERNAL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + INTERNAL_TOKEN,
      },
      body: JSON.stringify({
        pluginId: entry.pluginId,
        tool: entry.name,
        input,
      }),
      signal: AbortSignal.timeout(TOOL_CALL_TIMEOUT_MS),
    });

    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || !isToolOutcome(body)) {
      return {
        ok: false,
        error: "plugin tool call failed with status " + response.status,
      };
    }
    return body;
  } catch (error) {
    return {
      ok: false,
      error:
        "plugin tool call failed: " +
        (error instanceof Error ? error.message : String(error)),
    };
  }
};

const toolContent = (text: string, isError: boolean) => ({
  content: [{ type: "text", text }],
  isError,
});

const handleToolsCall = async (
  id: JsonRpcId | undefined,
  params: unknown,
): Promise<void> => {
  const name =
    isRecord(params) && typeof params.name === "string"
      ? params.name
      : undefined;
  const args = isRecord(params) ? (params.arguments ?? {}) : {};

  const entry = name ? findTool(name) : undefined;
  if (!entry) {
    respondResult(id, toolContent("Unknown tool: " + name, true));
    return;
  }

  if (!(INTERNAL_URL && INTERNAL_TOKEN)) {
    respondResult(id, toolContent("Plugin bridge is not configured", true));
    return;
  }

  const outcome = await callTool(entry, args);
  respondResult(
    id,
    toolContent(
      outcome.ok
        ? typeof outcome.output === "string"
          ? outcome.output
          : JSON.stringify(outcome.output)
        : outcome.error,
      !outcome.ok,
    ),
  );
};

const handleMessage = async (
  message: Record<string, unknown>,
): Promise<void> => {
  const id = message.id as JsonRpcId | undefined;
  const method =
    typeof message.method === "string" ? message.method : undefined;

  switch (method) {
    case "initialize": {
      respondResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "paco-plugins", version: "1.0.0" },
      });
      break;
    }
    case "notifications/initialized":
    case "notifications/cancelled": {
      // Notifications carry no id and expect no response.
      break;
    }
    case "ping": {
      respondResult(id, {});
      break;
    }
    case "tools/list": {
      respondResult(id, {
        tools: tools.map((entry) => ({
          name: toolFullName(entry),
          description: entry.description,
          inputSchema: isRecord(entry.inputSchema)
            ? entry.inputSchema
            : { type: "object" },
        })),
      });
      break;
    }
    case "tools/call": {
      await handleToolsCall(id, message.params);
      break;
    }
    default: {
      respondError(id, -32601, "Method not found: " + (method ?? "<none>"));
    }
  }
};

let buffer = "";

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;

  for (;;) {
    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex === -1) {
      break;
    }
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }

    // A broken single tool call must never crash the process and take the
    // whole MCP bridge down with it — every branch of handleMessage already
    // catches its own errors, so this is a last-resort backstop.
    handleMessage(parsed).catch(() => undefined);
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
