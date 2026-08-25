import { capabilitySchema } from "@paco/plugin-kit";
import { z } from "zod";

/**
 * The JSON-line RPC spoken between the host and a plugin worker process.
 *
 * Both ends validate every message against these schemas before acting on
 * it. The worker is untrusted code, so the host treats an unparseable or
 * schema-invalid line as a protocol violation (see MAX_MALFORMED_MESSAGES
 * in host.ts) rather than as something to coerce into shape.
 */

/**
 * Bounds on the ready handshake. A plugin registering ten thousand tools
 * with megabyte descriptions is not a feature; every one of these ends up in
 * a model-facing tool list the operator pays for.
 */
export const MAX_TOOL_NAME_LENGTH = 64;
export const MAX_TOOL_DESCRIPTION_LENGTH = 1000;
export const MAX_TOOLS_PER_PLUGIN = 64;

/** Tool names are identifiers, not free text: they reach an MCP tool list. */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** A model-facing tool a plugin registers during the ready handshake. */
export const registeredToolSchema = z.object({
  name: z.string().min(1).max(MAX_TOOL_NAME_LENGTH).regex(TOOL_NAME_PATTERN),
  description: z.string().max(MAX_TOOL_DESCRIPTION_LENGTH),
  inputSchema: z.unknown(),
});

export type RegisteredTool = {
  name: string;
  description: string;
  inputSchema: unknown;
};

/** Mirrors `PluginDescriptor["slots"]` from @paco/plugin-kit. */
export const pluginSlotsSchema = z.object({
  tools: z.array(z.string()),
  channels: z.array(z.string()),
  skills: z.array(z.string()),
  agents: z.array(z.string()),
  renderers: z.array(z.string()),
  hooks: z.array(z.string()),
});

export type PluginSlots = z.infer<typeof pluginSlotsSchema>;

export const hostToWorkerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("init"),
    pluginId: z.string(),
    grantedCapabilities: z.array(capabilitySchema),
    slots: pluginSlotsSchema,
  }),
  z.object({
    kind: z.literal("event"),
    id: z.number(),
    chatId: z.string(),
    event: z.unknown(),
  }),
  z.object({
    kind: z.literal("invoke-tool"),
    callId: z.string(),
    tool: z.string(),
    input: z.unknown(),
  }),
  z.object({
    kind: z.literal("capability-result"),
    requestId: z.string(),
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z.string().optional(),
  }),
  z.object({ kind: z.literal("cancel-tool"), callId: z.string() }),
  z.object({ kind: z.literal("shutdown") }),
]);

export type HostToWorkerMessage = z.infer<typeof hostToWorkerSchema>;

export const workerToHostSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ready"),
    tools: z.array(registeredToolSchema).max(MAX_TOOLS_PER_PLUGIN),
  }),
  z.object({
    kind: z.literal("capability-request"),
    requestId: z.string(),
    capability: capabilitySchema,
    payload: z.unknown(),
  }),
  z.object({
    kind: z.literal("tool-result"),
    callId: z.string(),
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: z.string().optional(),
  }),
  z.object({
    kind: z.literal("log"),
    level: z.enum(["info", "warn", "error"]),
    message: z.string(),
  }),
]);

export type WorkerToHostMessage = z.infer<typeof workerToHostSchema>;

/** Serializes one message as a single newline-delimited JSON line. */
export function encodeMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}
