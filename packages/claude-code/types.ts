/**
 * Types for the Claude Code CLI's `--output-format stream-json` protocol.
 *
 * Every shape here was verified against the CLI's actual NDJSON output
 * (v2.1.212) and the published headless documentation. The CLI emits one JSON
 * object per line; unknown `type`/`subtype` values are expected over time, so
 * consumers must treat these unions as open and ignore what they don't know.
 */

/** Anthropic content block as it appears inside an `assistant` message. */
export type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content?: unknown;
      is_error?: boolean;
    };

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  server_tool_use?: {
    web_search_requests?: number;
    web_fetch_requests?: number;
  };
  service_tier?: string;
}

export interface ClaudeModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests?: number;
  costUSD: number;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** `{"type":"system","subtype":"init",...}` — always the session preamble. */
export interface ClaudeInitMessage {
  type: "system";
  subtype: "init";
  cwd: string;
  session_id: string;
  model: string;
  permissionMode: string;
  tools: string[];
  mcp_servers: Array<{ name: string; status: string }>;
  /** Present only when a `--mcp-config` entry failed validation. */
  mcp_server_errors?: Array<{ name: string; type: string; message: string }>;
  agents?: string[];
  skills?: string[];
  slash_commands?: string[];
  plugins?: Array<{ name: string; path: string }>;
  /** Present only when a plugin failed to load. */
  plugin_errors?: Array<{ plugin: string; type: string; message: string }>;
  apiKeySource: string;
  claude_code_version?: string;
  output_style?: string;
  /**
   * Protocol capabilities. Feature-detect against this rather than comparing
   * version strings; treat unknown values as absent.
   */
  capabilities?: string[];
  uuid: string;
}

/** Emitted before Claude Code retries a failed API request. */
export interface ClaudeApiRetryMessage {
  type: "system";
  subtype: "api_retry";
  attempt: number;
  max_retries: number;
  retry_delay_ms: number;
  error_status: number | null;
  error: string;
  uuid: string;
  session_id: string;
}

/** Any other `system` message (hooks, thinking-token counters, plugin installs). */
export interface ClaudeGenericSystemMessage {
  type: "system";
  subtype: string;
  uuid?: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface ClaudeAssistantMessage {
  type: "assistant";
  message: {
    id: string;
    model: string;
    role: "assistant";
    content: ClaudeContentBlock[];
    stop_reason: string | null;
    usage?: ClaudeUsage;
  };
  /**
   * Set when this message came from a subagent; the value is the id of the
   * Agent tool call that spawned it. `null` for the main conversation.
   */
  parent_tool_use_id: string | null;
  session_id: string;
  uuid: string;
}

export interface ClaudeUserMessage {
  type: "user";
  message: { role: "user"; content: ClaudeContentBlock[] | string };
  parent_tool_use_id: string | null;
  session_id: string;
  uuid: string;
}

/** Raw Anthropic SSE event, forwarded when `--include-partial-messages` is set. */
export interface ClaudeStreamEventMessage {
  type: "stream_event";
  event: {
    type: string;
    index?: number;
    delta?: { type: string; text?: string; thinking?: string };
    content_block?: { type: string; id?: string; name?: string };
  };
  parent_tool_use_id: string | null;
  session_id: string;
  uuid: string;
}

export interface ClaudeRateLimitMessage {
  type: "rate_limit_event";
  rate_limit_info: {
    status: string;
    resetsAt?: number;
    rateLimitType?: string;
    overageStatus?: string;
    isUsingOverage?: boolean;
  };
  uuid: string;
  session_id: string;
}

/** Terminal message. Exactly one is emitted per run. */
export interface ClaudeResultMessage {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_during_execution" | string;
  is_error: boolean;
  duration_ms: number;
  duration_api_ms?: number;
  num_turns: number;
  /** Final assistant text. Absent on some error subtypes. */
  result?: string;
  /** Present when `--json-schema` was supplied. */
  structured_output?: unknown;
  stop_reason?: string | null;
  session_id: string;
  total_cost_usd?: number;
  usage?: ClaudeUsage;
  modelUsage?: Record<string, ClaudeModelUsage>;
  permission_denials?: Array<{
    tool_name: string;
    tool_use_id: string;
    tool_input?: unknown;
  }>;
  terminal_reason?: string;
  /** Failure messages from the CLI, present on error subtypes. */
  errors?: string[];
  uuid: string;
}

export type ClaudeMessage =
  | ClaudeInitMessage
  | ClaudeApiRetryMessage
  | ClaudeGenericSystemMessage
  | ClaudeAssistantMessage
  | ClaudeUserMessage
  | ClaudeStreamEventMessage
  | ClaudeRateLimitMessage
  | ClaudeResultMessage;

export function isInitMessage(m: ClaudeMessage): m is ClaudeInitMessage {
  return m.type === "system" && (m as ClaudeInitMessage).subtype === "init";
}

export function isResultMessage(m: ClaudeMessage): m is ClaudeResultMessage {
  return m.type === "result";
}

export function isAssistantMessage(
  m: ClaudeMessage,
): m is ClaudeAssistantMessage {
  return m.type === "assistant";
}
