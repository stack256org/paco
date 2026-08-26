/**
 * Wire types for `pool acp` (Poolside CLI 1.0.16, Agent Client Protocol
 * over stdio).
 *
 * Every shape here was read off a live handshake or a live turn against the
 * installed binary, not from documentation — docs.poolside.ai documents the
 * two flags and nothing about the message catalog. Where a field's presence
 * is conditional, the comment says which run showed it.
 */

/** `initialize` params. See `POOLSIDE_CLIENT_CAPABILITIES` in acp-client.ts. */
export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities: {
    fs: { readTextFile: boolean; writeTextFile: boolean };
    terminal: boolean;
  };
}

/**
 * `initialize` result, as `pool` 1.0.16 actually answers it.
 *
 * Note what is NOT here and is present in the ACP spec / OpenFX's version:
 * `promptCapabilities` carries only `image` (no `audio`, no
 * `embeddedContext`), and `mcpCapabilities` comes back as a bare `{}` —
 * meaning no `http`/`sse` transports. Stdio MCP servers still work (proved
 * by spawning one); they are simply not advertised here.
 */
export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: {
    loadSession?: boolean;
    promptCapabilities?: { image?: boolean };
    mcpCapabilities?: { http?: boolean; sse?: boolean };
    sessionCapabilities?: Record<string, unknown>;
    auth?: Record<string, unknown>;
    /**
     * Poolside's own extension flags. Observed live:
     * `poolside/system_prompt`, `poolside/session_steer`,
     * `poolside/mcp_settings`, `poolside/rewind`,
     * `poolside/compaction_update`, `poolside/early_session_config_options`,
     * `poolside/session_agent_config`, `poolside/session_lineage`,
     * `poolside/session_move`, and `poolside/service_mode` — the last a
     * STRING echoing the resolved endpoint (`"provider: inference.poolside.ai"`
     * by default), which is the single most useful connection-health signal
     * a settings page can show.
     */
    _meta?: Record<string, unknown>;
  };
  agentInfo: { name: string; title: string; version: string };
  /** `[]` when the CLI is already signed in via `~/.config/poolside/credentials.json`. */
  authMethods: unknown[];
}

/**
 * One entry of a session's `configOptions` — Poolside's per-session knobs.
 *
 * Live ids: `mode` (default | accept-edits | always-allow), `agent_mode`
 * (build | plan), `thought_level` (max | none), `model`
 * (poolside/laguna-s-2.1 | poolside/laguna-xs-2.1).
 */
export interface ConfigOption {
  id: string;
  name: string;
  category: string;
  type: string;
  currentValue: string;
  options: Array<{
    name: string;
    value: string;
    description?: string;
    _meta?: Record<string, unknown>;
  }>;
}

/**
 * One `configId`/`value` pair applied at session-creation time, via
 * `session/new`'s `_meta["poolside/early_session_config_options"]`.
 *
 * The key is `configId`, NOT `id`: an `{id, value}` element is rejected
 * with `applying config option : unknown config option` — verified against
 * the live binary, and the reason this has its own named type rather than
 * being written inline at the call site.
 */
export interface EarlyConfigOption {
  configId: string;
  value: string;
}

/**
 * One MCP server for a turn's session, in this package's ergonomic form.
 *
 * `env` is a `Record` here and an `EnvVariable[]` (`{name, value}`) on the
 * wire; `AcpClient` does that conversion so callers never see it. Unlike
 * OpenFX, `command` does NOT have to be absolute — a bare `"node"` is
 * resolved on PATH (verified by spawning a stub server that way and
 * watching the MCP handshake complete).
 *
 * Stdio only. `initialize` reports `mcpCapabilities: {}`, so there is no
 * http/sse transport to model.
 */
export interface PoolsideMcpServer {
  /** Non-empty; namespaces the server's tools. */
  name: string;
  /** Absolute path or a bare name resolved on PATH. */
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** `session/new` params. `cwd` is required — the session's workspace root. */
export interface NewSessionParams {
  cwd: string;
  mcpServers?: PoolsideMcpServer[];
  configOptions?: EarlyConfigOption[];
}

export interface NewSessionResult {
  sessionId: string;
  configOptions?: ConfigOption[];
}

export interface LoadSessionParams {
  sessionId: string;
  cwd: string;
  mcpServers?: PoolsideMcpServer[];
}

/** `session/load` answers with the session's config only — no `sessionId` echo. */
export interface LoadSessionResult {
  configOptions?: ConfigOption[];
}

/**
 * A prompt content block.
 *
 * `image` is real here, unlike OpenFX: `initialize` reports
 * `promptCapabilities: {image: true}`. It is typed from that advertisement
 * rather than from a live image turn (see this package's report).
 */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

export interface PromptParams {
  sessionId: string;
  prompt: ContentBlock[];
  _meta?: Record<string, unknown>;
}

/**
 * Token accounting from a completed `session/prompt`.
 *
 * Real numbers, not OpenFX's zeros. Absent entirely on a turn ended by
 * `session/cancel`.
 */
export interface PoolsideUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  /**
   * Cache WRITES. Never present on a `session/prompt` result — it appears
   * only under a `usage_update` notification's `_meta`, which is why
   * `usage.ts` reads both sources rather than just the result.
   */
  cachedWriteTokens?: number;
  totalTokens?: number;
}

/**
 * ACP's stop reasons.
 *
 * BEWARE: `pool` 1.0.16 answers a cancelled `session/prompt` with
 * `"end_turn"`, not `"cancelled"` — verified by cancelling a long turn and
 * reading the response (`{stopReason: "end_turn"}`, with no `usage`). So a
 * caller must NOT infer cancellation from this field; `PoolsideBackend`
 * tracks it with its own flag. `"cancelled"` stays in the union because the
 * protocol defines it and a future release may start sending it.
 */
export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_output_tokens"
  | "max_turn_requests"
  | "refusal"
  | "refused"
  | "cancelled";

export interface PromptResult {
  stopReason: StopReason;
  usage?: PoolsideUsage;
  /** Carries `poolside/task_outcome: {success: boolean}` — what drives `isError`. */
  _meta?: Record<string, unknown>;
}

/** `session/update` envelope. The `update` payload is chunk-mapper.ts's concern. */
export interface SessionUpdateEnvelope {
  sessionId: string;
  update: unknown;
}

/** `session/request_permission` params — same shape OpenFX used. */
export interface PermissionRequestParams {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    title: string;
    kind: string;
    status: "pending";
    /** Poolside DOES send the tool's real arguments here; OpenFX never did. */
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
 * resolving to) a decision sends the ordinary JSON-RPC response; throwing
 * sends a JSON-RPC error instead.
 */
export type PermissionHandler = (
  request: PermissionRequestParams,
) => Promise<PermissionDecision> | PermissionDecision;

/** `_poolside/session_system_prompt` result — a READ. See AcpClient.fetchSystemPrompt. */
export interface SystemPromptResult {
  systemPrompt: string;
}
