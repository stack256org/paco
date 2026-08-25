import "server-only";

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RegisteredTool } from "@paco/plugin-host";
import type { Capability, PluginManifest } from "@paco/plugin-kit";
import { mintPluginToolsToken } from "@/lib/plugins/tools-token";

/**
 * Bridges plugin-registered tools into the CLI's `--mcp-config`, so a running
 * turn can call them like any other MCP tool.
 *
 * One aggregate "paco-plugins" server fronts every enabled plugin's
 * registered tools (Task 5's `tools:register` slot) behind a single stdio
 * MCP server that forwards each call to Paco's own internal route
 * (`app/api/internal/plugin-tools/route.ts`), which looks the call up in the
 * running `PluginHost` registry (`lib/plugins/registry.ts`) and invokes it.
 * That is the ONLY server this file ever emits: it runs Paco's own script,
 * on Paco's own Node, and every call it forwards lands back inside the
 * plugin's sandboxed worker.
 *
 * Two gates decide what gets bridged, and both are checked here rather than
 * trusted from upstream:
 *
 * 1. **The operator's `tools:register` grant.** A plugin whose grant was
 *    denied contributes nothing, even if it is enabled and running and its
 *    host somehow handed tools over. `PluginHost` already drops such tools
 *    (`packages/plugin-host/host.ts`), but this is the process that decides
 *    what the CLI can reach, and it reads the consented list itself.
 * 2. **Manifest-declared `mcpServers` are refused outright.** See
 *    {@link REFUSED_MCP_SERVERS_REASON}.
 */

/**
 * One plugin, the operator's grants for it, and the tools its running host
 * registered.
 *
 * `grantedCapabilities` is `plugins.grantedCapabilities` from the database —
 * what the operator actually consented to on the install screen — never
 * `manifest.capabilities`, which is only what the plugin asked for.
 */
export interface EnabledPluginForMcp {
  id: string;
  manifest: PluginManifest;
  /** The operator's consented grants, from `plugins.grantedCapabilities`. */
  grantedCapabilities: Capability[];
  tools: RegisteredTool[];
}

/**
 * Why a `plugin.json` `mcpServers` entry never reaches the CLI.
 *
 * Such an entry is a `command`, `args` and `env` that the CLI spawns as a
 * plain child process of Paco: no `--permission`, no builtin allowlist, no
 * Node >= 24 floor, no symlink refusal, no `net:fetch` domain check — none
 * of the containment `packages/plugin-host/SECURITY.md` describes, because
 * none of it is in that path. It is host code execution as the Paco user,
 * and passing it through made the entire plugin sandbox optional for any
 * plugin that declared one.
 *
 * Refused rather than gated behind a grant, for three reasons.
 *
 * A grant is a checkbox, and the honest label for this one would be "may run
 * any command on this server as you" — which negates every other line on the
 * consent screen at once. Whatever an operator thought they were deciding by
 * denying `net:fetch` or `storage:kv`, they were not deciding this.
 *
 * The consent screen never shows the command. It could be made to, but the
 * thing shown would be a line like `npx -y @vendor/some-mcp-server`, which
 * an operator cannot review — the code it fetches is not the code they
 * hashed at install (`plugins.contentHash`), and a re-install can change the
 * manifest while the grant persists.
 *
 * And there is already a sandboxed way to do the thing this feature exists
 * for. A plugin that wants to give the model a tool registers it
 * (`tools:register`) and it is bridged through "paco-plugins" above, where
 * the call executes inside the plugin's own worker under every restriction
 * SECURITY.md claims. Nothing needs the unsandboxed path.
 *
 * The manifest schema still parses `mcpServers` (`@paco/plugin-kit`'s
 * `pluginManifestSchema`) so that a plugin declaring one installs and runs
 * with a clear warning rather than failing to parse — the declaration is
 * simply inert.
 */
export const REFUSED_MCP_SERVERS_REASON =
  "manifest-declared mcpServers are not supported: they would run as ordinary child processes of Paco, outside the plugin sandbox entirely. Register tools with tools:register instead.";

export interface BuildPluginMcpConfigOptions {
  /** Where the standalone MCP server posts tool-call requests. */
  internalUrl: string;
}

export type McpServerSpec = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

/**
 * The standalone MCP server, embedded as a string and written to disk on
 * first use.
 *
 * It cannot be shipped as a file the app merely imports: Claude Code
 * executes it as its own Node process, so what it needs is a real path on
 * disk. Getting one from `import.meta.url` does not survive bundling —
 * Turbopack rewrites the URL, the same failure documented for the
 * `PreToolUse` hook in `packages/claude-code/approval.ts` — so this is
 * written out the same way that hook is.
 *
 * `scripts/plugin-mcp-server.ts` is the readable copy and the one to edit;
 * `mcp-bridge.test.ts` fails if the two drift.
 */
export const PLUGIN_MCP_SERVER_SOURCE =
  '#!/usr/bin/env node\n/**\n * Standalone MCP server that bridges plugin-registered tools to the agent.\n *\n * Claude Code spawns this over stdio (per `--mcp-config`) and speaks\n * JSON-RPC 2.0 to it, one message per line (the MCP stdio transport). It\n * never talks to the plugin host or the database directly: it only knows\n * the flattened tool list handed to it via `PACO_PLUGIN_TOOLS`, and forwards\n * every `tools/call` to Paco\'s own internal route\n * (`app/api/internal/plugin-tools/route.ts`), which is the process that\n * actually holds the running `PluginHost` registry.\n *\n * Plain, dependency-free code with no imports beyond Node\'s own built-ins:\n * it runs as its own process, spawned by the CLI, not from the bundled app,\n * so it cannot rely on anything Next.js or a bundler provides.\n *\n * No top-level `function`/`var` declarations (only `const`/`let`), and\n * string concatenation instead of template literals: this file is embedded\n * as a plain string in `mcp-bridge.ts`, and a template literal\'s\n * interpolation syntax inside that embedded string reads to a linter as an\n * unresolved placeholder. A top-level `function` would otherwise leak onto\n * the global object once this file is spawned as a script rather than\n * imported.\n *\n * This file is the readable, lintable, type-checked copy.\n * `PLUGIN_MCP_SERVER_SOURCE` in `lib/plugins/mcp-bridge.ts` is the copy that\n * actually runs — the same reason the `PreToolUse` hook is embedded in\n * `packages/claude-code/approval.ts` rather than referenced by path: a\n * bundler rewrites `import.meta.url`, so a real path on disk cannot be\n * derived from it at runtime. `mcp-bridge.test.ts` fails if the two drift.\n */\n\n/**\n * The only environment variables this process is allowed to read.\n *\n * Claude Code spawns this script as a child of its own process\n * (`packages/claude-code/run.ts` starts the CLI with\n * `{...process.env, ...options.env}`), and there is no documented guarantee\n * that an MCP stdio server it in turn spawns from `--mcp-config` gets\n * anything narrower — the safe assumption is that this process inherits\n * Paco\'s FULL environment, `APP_SECRET`/`POSTGRES_URL`/`SMTP_*` included,\n * which directly contradicts the plan\'s "a plugin worker\'s environment\n * contains NO ambient secrets" invariant (spec Section 2). This script talks\n * to exactly one thing — Paco\'s own internal route, over the three values\n * below — so nothing else it might have inherited is ever needed, and the\n * scrub immediately below deletes everything else off `process.env` before\n * any other line of this file runs.\n */\nconst ALLOWED_ENV_KEYS = [\n  "PACO_INTERNAL_URL",\n  "PACO_INTERNAL_TOKEN",\n  "PACO_PLUGIN_TOOLS",\n];\n\ntype JsonRpcId = string | number | null;\n\ntype ToolEntry = {\n  pluginId: string;\n  name: string;\n  description: string;\n  inputSchema: unknown;\n};\n\ntype ToolOutcome = { ok: true; output: unknown } | { ok: false; error: string };\n\nconst INTERNAL_URL = process.env.PACO_INTERNAL_URL ?? "";\nconst INTERNAL_TOKEN = process.env.PACO_INTERNAL_TOKEN ?? "";\nconst TOOLS_JSON = process.env.PACO_PLUGIN_TOOLS ?? "[]";\n\n// Scrub now that the three values above are captured: every other key —\n// whatever this process actually inherited — is deleted off `process.env`\n// before any network call (`callTool`, well below) or anything else runs.\n// A single stderr line records what survived, for an operator debugging a\n// misconfigured bridge and for this behavior\'s own test — never stdout,\n// which is reserved for JSON-RPC protocol messages.\nfor (const key of Object.keys(process.env)) {\n  if (!ALLOWED_ENV_KEYS.includes(key)) {\n    delete process.env[key];\n  }\n}\nprocess.stderr.write(\n  "plugin-mcp-server: env scrubbed, keys retained: " +\n    Object.keys(process.env).sort().join(",") +\n    "\\n",\n);\n\nconst PROTOCOL_VERSION = "2024-11-05";\n/** Joins a plugin id and its tool name into the name exposed over MCP. */\nconst NAME_SEPARATOR = "__";\nconst TOOL_CALL_TIMEOUT_MS = 60_000;\n\nconst isRecord = (value: unknown): value is Record<string, unknown> =>\n  typeof value === "object" && value !== null;\n\n/** Never throws: malformed or missing input just yields no tools. */\nconst parseToolEntries = (json: string): ToolEntry[] => {\n  let raw: unknown;\n  try {\n    raw = JSON.parse(json);\n  } catch {\n    return [];\n  }\n  if (!Array.isArray(raw)) {\n    return [];\n  }\n\n  const entries: ToolEntry[] = [];\n  for (const item of raw) {\n    if (\n      isRecord(item) &&\n      typeof item.pluginId === "string" &&\n      typeof item.name === "string"\n    ) {\n      entries.push({\n        pluginId: item.pluginId,\n        name: item.name,\n        description:\n          typeof item.description === "string" ? item.description : "",\n        inputSchema: item.inputSchema,\n      });\n    }\n  }\n  return entries;\n};\n\nconst tools = parseToolEntries(TOOLS_JSON);\n\nconst toolFullName = (entry: ToolEntry): string =>\n  entry.pluginId + NAME_SEPARATOR + entry.name;\n\nconst findTool = (fullName: string): ToolEntry | undefined =>\n  tools.find((entry) => toolFullName(entry) === fullName);\n\nconst writeMessage = (message: Record<string, unknown>): void => {\n  process.stdout.write(JSON.stringify(message) + "\\n");\n};\n\nconst respondResult = (id: JsonRpcId | undefined, result: unknown): void => {\n  if (id === undefined || id === null) {\n    return;\n  }\n  writeMessage({ jsonrpc: "2.0", id, result });\n};\n\nconst respondError = (\n  id: JsonRpcId | undefined,\n  code: number,\n  message: string,\n): void => {\n  if (id === undefined || id === null) {\n    return;\n  }\n  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });\n};\n\nconst isToolOutcome = (value: unknown): value is ToolOutcome => {\n  if (!isRecord(value) || typeof value.ok !== "boolean") {\n    return false;\n  }\n  return value.ok ? "output" in value : typeof value.error === "string";\n};\n\n/** Forwards one tool call to Paco\'s internal route. Never throws. */\nconst callTool = async (\n  entry: ToolEntry,\n  input: unknown,\n): Promise<ToolOutcome> => {\n  try {\n    const response = await fetch(INTERNAL_URL, {\n      method: "POST",\n      headers: {\n        "Content-Type": "application/json",\n        Authorization: "Bearer " + INTERNAL_TOKEN,\n      },\n      body: JSON.stringify({\n        pluginId: entry.pluginId,\n        tool: entry.name,\n        input,\n      }),\n      signal: AbortSignal.timeout(TOOL_CALL_TIMEOUT_MS),\n    });\n\n    const body: unknown = await response.json().catch(() => null);\n    if (!response.ok || !isToolOutcome(body)) {\n      return {\n        ok: false,\n        error: "plugin tool call failed with status " + response.status,\n      };\n    }\n    return body;\n  } catch (error) {\n    return {\n      ok: false,\n      error:\n        "plugin tool call failed: " +\n        (error instanceof Error ? error.message : String(error)),\n    };\n  }\n};\n\nconst toolContent = (text: string, isError: boolean) => ({\n  content: [{ type: "text", text }],\n  isError,\n});\n\nconst handleToolsCall = async (\n  id: JsonRpcId | undefined,\n  params: unknown,\n): Promise<void> => {\n  const name =\n    isRecord(params) && typeof params.name === "string"\n      ? params.name\n      : undefined;\n  const args = isRecord(params) ? (params.arguments ?? {}) : {};\n\n  const entry = name ? findTool(name) : undefined;\n  if (!entry) {\n    respondResult(id, toolContent("Unknown tool: " + name, true));\n    return;\n  }\n\n  if (!(INTERNAL_URL && INTERNAL_TOKEN)) {\n    respondResult(id, toolContent("Plugin bridge is not configured", true));\n    return;\n  }\n\n  const outcome = await callTool(entry, args);\n  respondResult(\n    id,\n    toolContent(\n      outcome.ok\n        ? typeof outcome.output === "string"\n          ? outcome.output\n          : JSON.stringify(outcome.output)\n        : outcome.error,\n      !outcome.ok,\n    ),\n  );\n};\n\nconst handleMessage = async (\n  message: Record<string, unknown>,\n): Promise<void> => {\n  const id = message.id as JsonRpcId | undefined;\n  const method =\n    typeof message.method === "string" ? message.method : undefined;\n\n  switch (method) {\n    case "initialize": {\n      respondResult(id, {\n        protocolVersion: PROTOCOL_VERSION,\n        capabilities: { tools: {} },\n        serverInfo: { name: "paco-plugins", version: "1.0.0" },\n      });\n      break;\n    }\n    case "notifications/initialized":\n    case "notifications/cancelled": {\n      // Notifications carry no id and expect no response.\n      break;\n    }\n    case "ping": {\n      respondResult(id, {});\n      break;\n    }\n    case "tools/list": {\n      respondResult(id, {\n        tools: tools.map((entry) => ({\n          name: toolFullName(entry),\n          description: entry.description,\n          inputSchema: isRecord(entry.inputSchema)\n            ? entry.inputSchema\n            : { type: "object" },\n        })),\n      });\n      break;\n    }\n    case "tools/call": {\n      await handleToolsCall(id, message.params);\n      break;\n    }\n    default: {\n      respondError(id, -32601, "Method not found: " + (method ?? "<none>"));\n    }\n  }\n};\n\nlet buffer = "";\n\nprocess.stdin.setEncoding("utf-8");\nprocess.stdin.on("data", (chunk: string) => {\n  buffer += chunk;\n\n  for (;;) {\n    const newlineIndex = buffer.indexOf("\\n");\n    if (newlineIndex === -1) {\n      break;\n    }\n    const line = buffer.slice(0, newlineIndex).trim();\n    buffer = buffer.slice(newlineIndex + 1);\n    if (!line) {\n      continue;\n    }\n\n    let parsed: unknown;\n    try {\n      parsed = JSON.parse(line);\n    } catch {\n      continue;\n    }\n    if (!isRecord(parsed)) {\n      continue;\n    }\n\n    // A broken single tool call must never crash the process and take the\n    // whole MCP bridge down with it — every branch of handleMessage already\n    // catches its own errors, so this is a last-resort backstop.\n    handleMessage(parsed).catch(() => undefined);\n  }\n});\n\nprocess.stdin.on("end", () => {\n  process.exit(0);\n});\n';

/**
 * Where the standalone MCP server lives once written.
 *
 * Alongside the approval hook, under Paco's own directory — never inside
 * the user's repository.
 */
function pluginMcpServerScriptPath(): string {
  const dir = join(homedir(), ".paco", "mcp");
  mkdirSync(dir, { recursive: true });

  const target = join(dir, "plugin-mcp-server.ts");
  // Rewritten every time rather than only when missing, same reasoning as
  // the approval hook: a stale copy from an older build would silently run
  // yesterday's bridge logic.
  writeFileSync(target, PLUGIN_MCP_SERVER_SOURCE, "utf-8");
  chmodSync(target, 0o755);

  return target;
}

/**
 * Logs the manifest-declared `mcpServers` this bridge refused, once per
 * plugin, naming every server so an operator whose plugin quietly does
 * nothing can find out why. A warning rather than a failure: the spec's
 * degradation invariant (Section 2) says a plugin must never fail the turn
 * that touched it, and the rest of the plugin still works.
 */
function warnAboutRefusedServers(plugin: EnabledPluginForMcp): void {
  const declared = plugin.manifest.mcpServers;
  if (!declared) {
    return;
  }
  console.warn(`plugin mcp bridge: ${REFUSED_MCP_SERVERS_REASON}`, {
    id: plugin.id,
    servers: Object.keys(declared),
  });
}

/**
 * Builds the `--mcp-config` entries for every enabled plugin.
 *
 * `enabled` is deliberately not looked up here: the caller already has it
 * from starting each plugin's host (`ensurePluginsStarted`,
 * `lib/plugins/registry.ts`), and this function does no I/O of its own
 * beyond writing the bridge script to disk.
 */
export function buildPluginMcpConfig(
  enabled: EnabledPluginForMcp[],
  opts: BuildPluginMcpConfigOptions,
): Record<string, McpServerSpec> {
  const config: Record<string, McpServerSpec> = {};

  const pluginsWithTools = enabled.filter(
    (plugin) =>
      plugin.tools.length > 0 &&
      plugin.grantedCapabilities.includes("tools:register"),
  );
  const toolEntries = pluginsWithTools.flatMap((plugin) =>
    plugin.tools.map((tool) => ({
      pluginId: plugin.id,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  );

  if (toolEntries.length > 0) {
    // Scoped to exactly the plugins this bridge actually fronts — a plugin
    // contributing no registered tools has nothing this bridge could ever
    // invoke, so it has no business being in scope either (see
    // `lib/plugins/tools-token.ts` for why a single shared secret was not
    // enough here).
    const token = mintPluginToolsToken(
      pluginsWithTools.map((plugin) => plugin.id),
    );
    config["paco-plugins"] = {
      // Paco's own server process runs on Node (Next.js requires it), so
      // process.execPath here is always a real, production Node binary —
      // the same "bundled node" the plugin host itself pins for workers.
      command: process.execPath,
      args: [pluginMcpServerScriptPath()],
      env: {
        PACO_INTERNAL_URL: opts.internalUrl,
        PACO_INTERNAL_TOKEN: token,
        PACO_PLUGIN_TOOLS: JSON.stringify(toolEntries),
      },
    };
  }

  for (const plugin of enabled) {
    warnAboutRefusedServers(plugin);
  }

  return config;
}
