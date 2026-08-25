import type { UIMessageChunk } from "ai";

/**
 * Real shapes of the `session/update` `update` payload (PROTOCOL.md §3).
 *
 * `acp-client.ts` deliberately types `SessionUpdateEnvelope.update` as
 * `unknown` and defers this mapping to this file (see its class doc). The
 * discriminant field is `sessionUpdate`, confirmed against
 * `openfx/src/acp/types.zig`'s `write*` functions (e.g. `writeAgentMessageChunk`
 * writes `{"sessionUpdate":"agent_message_chunk",...}`) — PROTOCOL.md's table
 * names the variants but doesn't spell out the wire key, so this was verified
 * directly against source rather than guessed.
 */

/** `openfx/src/acp/types.zig` `ToolCallKind.jsonString()`. */
export type AcpToolCallKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "other";

/** `openfx/src/acp/types.zig` `ToolCallStatus.jsonString()`. */
export type AcpToolCallStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed";

interface AcpTextContent {
  type: "text";
  text: string;
}

/** `writeAgentMessageChunk` — incremental assistant text. */
export interface AgentMessageChunkUpdate {
  sessionUpdate: "agent_message_chunk";
  content: AcpTextContent;
}

/** `writeUserMessageChunk` — only seen replaying history on `session/load`. */
export interface UserMessageChunkUpdate {
  sessionUpdate: "user_message_chunk";
  content: AcpTextContent;
}

/**
 * `writeToolCall` — announces a new tool call. Carries no `rawInput`: that
 * field only appears on `session/request_permission` params
 * (`openfx/src/acp/prompt.zig:1332`), never on this notification. So the ACP
 * wire never gives this backend the tool's actual arguments.
 */
export interface ToolCallCreatedUpdate {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  kind: AcpToolCallKind;
  status: "pending";
}

/** One item of `tool_call_update`'s `content` array (`writeToolCallUpdateWithCommandResult`). */
export interface AcpToolCallContentItem {
  type: "content";
  content: AcpTextContent;
}

/**
 * `writeToolCallUpdateWithCommandResult` — lifecycle transition for a tool
 * call already announced via `tool_call`. `content` carries result text;
 * `command_result` is the structured exec result (`kind`, `command`, `cwd`,
 * `exit_code`, `signal`, `timed_out`, `stdout_bytes`, `stderr_bytes`,
 * `truncated` — `openfx/src/acp/types.zig` test at line ~272) and is passed
 * through opaquely since PROTOCOL.md doesn't pin its shape as a named type.
 */
export interface ToolCallStatusUpdate {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  status: AcpToolCallStatus;
  content?: AcpToolCallContentItem[];
  command_result?: unknown;
}

/** `writeAvailableCommandsUpdate` — slash-command catalog, not message content. */
export interface AvailableCommandsUpdate {
  sessionUpdate: "available_commands_update";
  availableCommands: unknown[];
}

/**
 * `writeModelRecoveryInfoUpdate` — provider-outage/backoff status
 * (PROTOCOL.md §3, §6: explicitly not a token-usage report). Not message
 * content either.
 */
export interface SessionInfoUpdate {
  sessionUpdate: "session_info_update";
  _meta?: unknown;
}

/**
 * Catch-all for any `sessionUpdate` kind not in PROTOCOL.md's table.
 * PROTOCOL.md §8.4: the ACP wire carries no stability guarantee at all, so a
 * future OpenFX release adding a new kind must not throw — it should be
 * ignored (and logged once) rather than crash the turn.
 */
export interface UnknownSessionUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

export type AcpSessionUpdate =
  | AgentMessageChunkUpdate
  | UserMessageChunkUpdate
  | ToolCallCreatedUpdate
  | ToolCallStatusUpdate
  | AvailableCommandsUpdate
  | SessionInfoUpdate
  | UnknownSessionUpdate;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Best-effort text extraction from an `{type:"text",text}` content block. */
function getText(content: unknown): string {
  return isRecord(content) &&
    content.type === "text" &&
    typeof content.text === "string"
    ? content.text
    : "";
}

/** Best-effort text extraction from a `tool_call_update`'s `content` array. */
function extractToolCallContentText(
  content: AcpToolCallContentItem[] | undefined,
): string {
  if (!content) {
    return "";
  }
  const parts: string[] = [];
  for (const item of content) {
    if (isRecord(item) && item.type === "content") {
      const text = getText(item.content);
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts.join("\n");
}

/** `tool-output-available`'s `output`, folding in `command_result` when present. */
function buildToolOutput(update: ToolCallStatusUpdate): unknown {
  const text = extractToolCallContentText(update.content);
  if (update.command_result !== undefined) {
    return { text, commandResult: update.command_result };
  }
  return text;
}

/**
 * Translates OpenFX ACP `session/update` payloads into AI SDK
 * `UIMessageChunk`s, mirroring `ClaudeUIStreamMapper`
 * (`packages/claude-code/ui-stream.ts`): stateful across a turn so an
 * in-flight text block can be closed by whatever interrupts it, and
 * `finish()` closes anything still open (an interrupted/cancelled turn must
 * not leave a dangling `text-start` with no matching `text-end`).
 *
 * Unlike Claude Code's `assistant` messages, ACP never delivers block
 * boundaries for text — `agent_message_chunk` is just a flat stream of
 * deltas, and the only way to know a text run ended is that something else
 * (a tool call, or the end of the turn) came along. So one open text id is
 * tracked and closed lazily, the first time anything non-text arrives.
 *
 * `tool-input-delta` (AI SDK's incremental-arguments chunk) is never emitted
 * here, matching `ClaudeUIStreamMapper`: ACP's `tool_call` carries no
 * `rawInput` at all (see `ToolCallCreatedUpdate`'s doc), so there is no
 * argument stream to relay — `tool-input-start` and `tool-input-available`
 * are emitted back-to-back instead, with `input: {}` since no real
 * arguments exist on the wire.
 */
export class AcpChunkMapper {
  #blockSeq = 0;
  #openTextId: string | undefined;
  #warnedKinds = new Set<string>();

  #nextId(prefix: string): string {
    this.#blockSeq += 1;
    return `${prefix}-${this.#blockSeq}`;
  }

  /** Close the in-flight text block, if any, and return its `text-end` chunk. */
  #closeOpenText(): UIMessageChunk[] {
    const id = this.#openTextId;
    if (!id) {
      return [];
    }
    this.#openTextId = undefined;
    return [{ type: "text-end", id }];
  }

  #mapAgentMessageChunk(update: AgentMessageChunkUpdate): UIMessageChunk[] {
    const chunks: UIMessageChunk[] = [];
    let id = this.#openTextId;
    if (!id) {
      id = this.#nextId("text");
      this.#openTextId = id;
      chunks.push({ type: "text-start", id });
    }
    chunks.push({ type: "text-delta", id, delta: getText(update.content) });
    return chunks;
  }

  #mapToolCallCreated(update: ToolCallCreatedUpdate): UIMessageChunk[] {
    return [
      {
        type: "tool-input-start",
        toolCallId: update.toolCallId,
        toolName: update.kind,
        title: update.title,
      },
      {
        type: "tool-input-available",
        toolCallId: update.toolCallId,
        toolName: update.kind,
        input: {},
        title: update.title,
      },
    ];
  }

  #mapToolCallStatus(update: ToolCallStatusUpdate): UIMessageChunk[] {
    switch (update.status) {
      case "completed":
        return [
          {
            type: "tool-output-available",
            toolCallId: update.toolCallId,
            output: buildToolOutput(update),
          },
        ];
      case "failed": {
        const text = extractToolCallContentText(update.content);
        return [
          {
            type: "tool-output-error",
            toolCallId: update.toolCallId,
            errorText: text || "Tool call failed",
          },
        ];
      }
      // "pending" is only expected via `tool_call`, not `tool_call_update`.
      // "in_progress" has no corresponding AI SDK tool-part state beyond the
      // input-available one already emitted at `tool_call` time.
      default:
        return [];
    }
  }

  #warnUnknown(kind: string): void {
    if (this.#warnedKinds.has(kind)) {
      return;
    }
    this.#warnedKinds.add(kind);
    console.warn(`AcpChunkMapper: unknown session/update kind "${kind}"`);
  }

  /**
   * Map one `session/update` payload to zero or more UI chunks.
   *
   * Takes `unknown` because that is exactly what `AcpClient` hands over
   * (`SessionUpdateEnvelope.update: unknown` — see its class doc): the wire
   * carries no stability guarantee (PROTOCOL.md §8.4), so this is a real
   * parse-at-the-boundary, not a formality. `AcpSessionUpdate` is exported
   * for callers that want to construct well-typed fixtures.
   *
   * `kind` is read out separately, rather than narrowing `update` itself to
   * a record, so the casts below start from `unknown` — matching how
   * `acp-client.ts` casts `params as PermissionRequestParams` at its own
   * JSON-RPC boundary — instead of an object-to-object cast TypeScript can't
   * verify overlaps.
   */
  map(update: unknown): UIMessageChunk[] {
    const kind =
      isRecord(update) && typeof update.sessionUpdate === "string"
        ? update.sessionUpdate
        : undefined;

    if (kind === undefined) {
      this.#warnUnknown(typeof update);
      return [];
    }

    if (kind === "agent_message_chunk") {
      return this.#mapAgentMessageChunk(update as AgentMessageChunkUpdate);
    }

    // Every other kind ends any text run in progress: ACP gives no explicit
    // text block boundary, so the arrival of anything else is the signal.
    const closing = this.#closeOpenText();

    switch (kind) {
      case "user_message_chunk":
        // Only seen replaying history on session/load; it is the user's own
        // prior turn, not assistant output, so nothing is emitted for it.
        return closing;

      case "tool_call":
        return [
          ...closing,
          ...this.#mapToolCallCreated(update as ToolCallCreatedUpdate),
        ];

      case "tool_call_update":
        return [
          ...closing,
          ...this.#mapToolCallStatus(update as ToolCallStatusUpdate),
        ];

      case "available_commands_update":
      case "session_info_update":
        // Slash-command catalog / provider-outage recovery state — control
        // plane, not message content; nothing maps to a UIMessageChunk.
        return closing;

      default:
        this.#warnUnknown(kind);
        return closing;
    }
  }

  /** Close anything left open, so an interrupted/cancelled turn stays valid. */
  finish(): UIMessageChunk[] {
    const chunks = this.#closeOpenText();
    return chunks;
  }
}
