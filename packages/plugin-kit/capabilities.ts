import { z } from "zod";

/**
 * The full capability vocabulary a plugin manifest can request.
 *
 * Each capability is enforced by the plugin host, not the plugin process:
 * granting one only ever widens what the host will do on the plugin's
 * behalf. See spec Section 2 for the security invariants.
 */
export const CAPABILITIES = [
  "events:subscribe", // receive session events for chats in this instance
  "messages:post", // post a user message into a chat
  "tools:register", // contribute model-facing tools (bridged over MCP)
  "net:fetch", // outbound HTTP to declared domains only
  "storage:kv", // per-plugin key-value storage
  "ui:panel", // contribute a sandboxed iframe panel
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const capabilitySchema: z.ZodType<Capability> = z.enum(CAPABILITIES);
