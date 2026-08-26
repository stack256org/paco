import type { UIMessageChunk } from "ai";

/**
 * Real shapes of Poolside's `session/update` `update` payload, read off
 * live turns against `pool` 1.0.16.
 *
 * The discriminant is `sessionUpdate`. The kinds below are the ones a turn
 * actually produced; `current_mode_update` and `plan` are additionally
 * recognised as control-plane so a future release emitting them doesn't
 * trip the unknown-kind warning.
 */

interface AcpTextContent {
  type: "text";
  text: string;
}

/** Incremental assistant text. Carries a `messageId` and a `poolside/step_id`. */
export interface AgentMessageChunkUpdate {
  sessionUpdate: "agent_message_chunk";
  content: AcpTextContent;
  messageId?: string;
}

/**
 * Incremental reasoning text — Poolside's thinking stream, emitted when the
 * session's `thought_level` is `max` (its default).
 *
 * OpenFX had no equivalent, which is why this maps to the AI SDK's
 * `reasoning-*` chunks rather than being folded into ordinary text: Paco's
 * UI already renders reasoning as a collapsible block for Claude Code, and
 * flattening it into `text-delta` would put raw chain-of-thought into the
 * assistant's visible message.
 */
export interface AgentThoughtChunkUpdate {
  sessionUpdate: "agent_thought_chunk";
  content: AcpTextContent;
}

/** The user's own prior turn — only ever seen replaying history on `session/load`. */
export interface UserMessageChunkUpdate {
  sessionUpdate: "user_message_chunk";
  content: AcpTextContent;
}

/**
 * A new tool call.
 *
 * Unlike OpenFX's, this DOES carry `rawInput` — the tool's real arguments —
 * so the mapper can emit them instead of an empty object. `_meta.tool_name`
 * is Poolside's own tool identifier (`"shell"`), which is more specific
 * than the ACP `kind` (`"execute"`).
 */
export interface ToolCallCreatedUpdate {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  kind: string;
  status: string;
  rawInput?: unknown;
  _meta?: { tool_name?: string };
}

/** One item of a `tool_call_update`'s `content` array. */
export interface AcpToolCallContentItem {
  type: "content";
  content: AcpTextContent;
}

/**
 * A lifecycle transition for a tool call already announced by `tool_call`.
 *
 * `content` carries the displayable result; `rawOutput.observation` carries
 * Poolside's fuller rendering (command, exit code, status, output), used as
 * a fallback when `content` is empty.
 */
export interface ToolCallStatusUpdate {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  status: string;
  content?: AcpToolCallContentItem[];
  rawOutput?: unknown;
}

/**
 * Live context-window accounting: `used` of `size` tokens, with per-kind
 * counts under `_meta`.
 *
 * Not message content, so it maps to no chunk — but `usage.ts` reads it,
 * because it is the ONLY usage a cancelled turn ever reports (a cancelled
 * `session/prompt` answers with no `usage` field at all).
 */
export interface UsageUpdate {
  sessionUpdate: "usage_update";
  size?: number;
  used?: number;
  _meta?: Record<string, unknown>;
}

/** Catch-all for a kind this mapper doesn't know: ignored and warned once. */
export interface UnknownSessionUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

export type PoolsideSessionUpdate =
  | AgentMessageChunkUpdate
  | AgentThoughtChunkUpdate
  | UserMessageChunkUpdate
  | ToolCallCreatedUpdate
  | ToolCallStatusUpdate
  | UsageUpdate
  | UnknownSessionUpdate;

/**
 * Kinds that are control plane, not message content, and — crucially — not
 * a turn boundary either: they can arrive in the middle of an assistant's
 * text run, and closing the run for them would fragment one message into
 * several for no reason on the wire.
 *
 * `available_commands_update`, `config_option_update` and
 * `session_info_update` were all observed mid-turn. `current_mode_update`
 * and `plan` are ACP-standard kinds this build has not seen from Poolside;
 * they are listed so that if a future release starts sending them they are
 * ignored quietly rather than warned about.
 */
const IGNORED_UPDATE_KINDS: ReadonlySet<string> = new Set([
  "available_commands_update",
  "config_option_update",
  "current_mode_update",
  "plan",
  "session_info_update",
  "usage_update",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Best-effort text out of a `{type:"text", text}` content block. */
function getText(content: unknown): string {
  return isRecord(content) &&
    content.type === "text" &&
    typeof content.text === "string"
    ? content.text
    : "";
}

/** Best-effort text out of a `tool_call_update`'s `content` array. */
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
 * `tool-output-available`'s `output`, always a plain string.
 *
 * `content` first — it is the rendering Poolside means for display. When it
 * is empty, `rawOutput.observation` is used: on a shell call that string
 * carries the command, its exit code and its output, so falling back to it
 * keeps a silent-but-failed command from showing as nothing at all.
 */
function buildToolOutput(update: ToolCallStatusUpdate): string {
  const text = extractToolCallContentText(update.content);
  if (text) {
    return text;
  }
  const rawOutput = update.rawOutput;
  if (isRecord(rawOutput) && typeof rawOutput.observation === "string") {
    return rawOutput.observation;
  }
  return "";
}

/**
 * Translates Poolside ACP `session/update` payloads into AI SDK
 * `UIMessageChunk`s, mirroring `ClaudeUIStreamMapper`
 * (`packages/claude-code/ui-stream.ts`): stateful across a turn, so an
 * in-flight text or reasoning block can be closed by whatever interrupts
 * it, and `finish()` closes whatever is still open — an interrupted turn
 * must not leave a dangling `text-start` with no `text-end`.
 *
 * ACP delivers no block boundaries: `agent_message_chunk` and
 * `agent_thought_chunk` are flat delta streams, and the only signal that a
 * run ended is that something else arrived. So one open text id and one
 * open reasoning id are tracked and closed lazily — by each other, by a
 * tool call, by the user's replayed message, or by `finish()`.
 *
 * `tool-input-delta` is never emitted: `tool_call` arrives with its
 * complete `rawInput`, so there is no argument stream to relay —
 * `tool-input-start` and `tool-input-available` go out back to back.
 */
export class PoolsideChunkMapper {
  #blockSeq = 0;
  #openTextId: string | undefined;
  #openReasoningId: string | undefined;
  #warnedKinds = new Set<string>();

  #nextId(prefix: string): string {
    this.#blockSeq += 1;
    return `${prefix}-${this.#blockSeq}`;
  }

  #closeOpenText(): UIMessageChunk[] {
    const id = this.#openTextId;
    if (!id) {
      return [];
    }
    this.#openTextId = undefined;
    return [{ type: "text-end", id }];
  }

  #closeOpenReasoning(): UIMessageChunk[] {
    const id = this.#openReasoningId;
    if (!id) {
      return [];
    }
    this.#openReasoningId = undefined;
    return [{ type: "reasoning-end", id }];
  }

  #closeOpenBlocks(): UIMessageChunk[] {
    return [...this.#closeOpenReasoning(), ...this.#closeOpenText()];
  }

  #mapAgentMessageChunk(update: AgentMessageChunkUpdate): UIMessageChunk[] {
    // Assistant text ends any thinking run: they never interleave.
    const chunks: UIMessageChunk[] = this.#closeOpenReasoning();
    let id = this.#openTextId;
    if (!id) {
      id = this.#nextId("text");
      this.#openTextId = id;
      chunks.push({ type: "text-start", id });
    }
    chunks.push({ type: "text-delta", id, delta: getText(update.content) });
    return chunks;
  }

  #mapAgentThoughtChunk(update: AgentThoughtChunkUpdate): UIMessageChunk[] {
    const chunks: UIMessageChunk[] = this.#closeOpenText();
    let id = this.#openReasoningId;
    if (!id) {
      id = this.#nextId("reasoning");
      this.#openReasoningId = id;
      chunks.push({ type: "reasoning-start", id });
    }
    chunks.push({
      type: "reasoning-delta",
      id,
      delta: getText(update.content),
    });
    return chunks;
  }

  #mapToolCallCreated(update: ToolCallCreatedUpdate): UIMessageChunk[] {
    // Poolside's own tool identifier when present (`"shell"`), falling back
    // to the coarser ACP kind (`"execute"`).
    const toolName =
      typeof update._meta?.tool_name === "string"
        ? update._meta.tool_name
        : update.kind;
    // `rawInput` is genuinely on the wire here, so the UI gets the real
    // arguments rather than OpenFX's `{}`.
    const input = update.rawInput ?? {};
    return [
      {
        type: "tool-input-start",
        toolCallId: update.toolCallId,
        toolName,
        title: update.title,
      },
      {
        type: "tool-input-available",
        toolCallId: update.toolCallId,
        toolName,
        input,
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
        const text = buildToolOutput(update);
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
        // Live progress, not a final result: streamed command output
        // arrives as `in_progress` with `content`. A bare status
        // transition with nothing to show emits nothing.
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
    console.warn(`PoolsideChunkMapper: unknown session/update kind "${kind}"`);
  }

  /**
   * Map one `session/update` payload to zero or more UI chunks.
   *
   * Takes `unknown` because that is exactly what `AcpClient` hands over
   * (`SessionUpdateEnvelope.update`). The ACP wire carries no stability
   * guarantee, so this is a real parse-at-the-boundary: `update` is
   * narrowed only far enough to read `sessionUpdate`, and each per-kind
   * cast goes through `as unknown as X` because TypeScript won't take a
   * `Record<string, unknown>` straight to an interface it can't prove
   * overlaps.
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

    if (IGNORED_UPDATE_KINDS.has(kind)) {
      return [];
    }

    switch (kind) {
      case "agent_message_chunk":
        return this.#mapAgentMessageChunk(
          update as unknown as AgentMessageChunkUpdate,
        );

      case "agent_thought_chunk":
        return this.#mapAgentThoughtChunk(
          update as unknown as AgentThoughtChunkUpdate,
        );

      case "user_message_chunk":
        // The user's own prior turn, replayed by `session/load`. Nothing is
        // emitted for it, but it does end any open assistant run.
        return this.#closeOpenBlocks();

      case "tool_call":
        return [
          ...this.#closeOpenBlocks(),
          ...this.#mapToolCallCreated(
            update as unknown as ToolCallCreatedUpdate,
          ),
        ];

      case "tool_call_update":
        return [
          ...this.#closeOpenBlocks(),
          ...this.#mapToolCallStatus(update as unknown as ToolCallStatusUpdate),
        ];

      default:
        this.#warnUnknown(kind);
        return [];
    }
  }

  /** Close anything still open, so an interrupted turn stays a valid stream. */
  finish(): UIMessageChunk[] {
    return this.#closeOpenBlocks();
  }
}
