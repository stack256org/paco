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

/**
 * `tool-output-available`'s `output` — always a plain string (there is no UI
 * consumer for a `{text, commandResult}` object form). When `command_result`
 * carries a numeric `exit_code` (the structured exec result documented on
 * `ToolCallStatusUpdate`), a trailing `[exit code N]` line is appended so the
 * exit status survives even though the object itself is dropped. No separate
 * stderr text field was found on `command_result` (only a `stderr_bytes`
 * count — `openfx/src/acp/types.zig` test) — stderr is already folded into
 * `content`'s `<stderr>...</stderr>` envelope upstream
 * (`openfx/src/core/execution/command_contract.zig`), so there is nothing
 * separate left to append here.
 */
function buildToolOutput(update: ToolCallStatusUpdate): string {
  const text = extractToolCallContentText(update.content);
  const commandResult = update.command_result;
  if (isRecord(commandResult) && typeof commandResult.exit_code === "number") {
    return `${text}\n[exit code ${commandResult.exit_code}]`;
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
      case "in_progress":
      case "pending": {
        // Live progress, not the final result: `onCommandOutputChunk` (Bash
        // output) and `onMcpProgress` (MCP progress) both stream through
        // `sendToolCallProgressText`, which always writes status
        // `in_progress` with `content` (`openfx/src/acp/prompt.zig:1957,1962`
        // -> `sendToolCallProgressText` at `prompt.zig:160`). `pending` with
        // content is not observed from that call site — `tool_call` is the
        // only place `pending` is used on the wire — but is handled the same
        // way defensively (PROTOCOL.md §8.4: no stability guarantee). No
        // content means just a bare status transition with nothing to show.
        const text = extractToolCallContentText(update.content);
        if (!text) {
          return [];
        }
        return [
          {
            type: "tool-output-available",
            toolCallId: update.toolCallId,
            output: text,
            preliminary: true,
          },
        ];
      }
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
   * `update` is narrowed only far enough to read `sessionUpdate` (a
   * `Record<string, unknown>`); the per-kind casts below go through `as
   * unknown as X` because TypeScript won't let a `Record<string, unknown>`
   * cast straight to a more specific interface it can't prove overlaps —
   * the same trust-the-wire boundary `acp-client.ts` takes with `params as
   * PermissionRequestParams`, just starting one step further from `unknown`.
   *
   * Only `tool_call`, `tool_call_update`, and `user_message_chunk` close an
   * open text run (plus `finish()`, for whatever is still open at turn end).
   * `session_info_update` (model-recovery notices) and
   * `available_commands_update` are control-plane and can arrive mid-stream
   * without meaning the assistant's text run ended — closing text for them
   * would fragment one message into several for no reason on the wire. An
   * unrecognized kind is treated the same way: PROTOCOL.md §8.4 promises no
   * stability, so a future kind this mapper doesn't understand yet shouldn't
   * be assumed to be a turn boundary either.
   */
  map(update: unknown): UIMessageChunk[] {
    if (!isRecord(update)) {
      this.#warnUnknown(`malformed:${typeof update}`);
      return [];
    }
    if (typeof update.sessionUpdate !== "string") {
      this.#warnUnknown("missing-sessionUpdate");
      return [];
    }
    const kind = update.sessionUpdate;

    switch (kind) {
      case "agent_message_chunk":
        return this.#mapAgentMessageChunk(
          update as unknown as AgentMessageChunkUpdate,
        );

      case "user_message_chunk":
        // Only seen replaying history on session/load; it is the user's own
        // prior turn, not assistant output, so nothing is emitted for it —
        // but it does end any open assistant text run.
        return this.#closeOpenText();

      case "tool_call":
        return [
          ...this.#closeOpenText(),
          ...this.#mapToolCallCreated(
            update as unknown as ToolCallCreatedUpdate,
          ),
        ];

      case "tool_call_update":
        return [
          ...this.#closeOpenText(),
          ...this.#mapToolCallStatus(update as unknown as ToolCallStatusUpdate),
        ];

      case "available_commands_update":
      case "session_info_update":
        // Slash-command catalog / provider-outage recovery state — control
        // plane, not message content, and not a turn boundary: leaves any
        // open text run untouched.
        return [];

      default:
        this.#warnUnknown(kind);
        return [];
    }
  }

  /** Close anything left open, so an interrupted/cancelled turn stays valid. */
  finish(): UIMessageChunk[] {
    const chunks = this.#closeOpenText();
    return chunks;
  }
}
