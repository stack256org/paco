import type { UIMessageChunk } from "ai";
import type { ClaudeContentBlock, ClaudeMessage } from "./types.ts";

/**
 * Claude Code tool name -> the canonical name the UI renderers dispatch on.
 *
 * Normalizing here keeps the renderers unchanged; anything unmapped passes
 * through and falls back to the generic tool renderer.
 */
const TOOL_NAME_MAP: Record<string, string> = {
  Bash: "bash",
  Read: "read",
  Write: "write",
  Edit: "edit",
  Glob: "glob",
  Grep: "grep",
  Task: "task",
  Agent: "task",
  TodoWrite: "todo_write",
  AskUserQuestion: "ask_user_question",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
  Skill: "skill",
  NotebookEdit: "notebook_edit",
};

export function normalizeToolName(name: string): string {
  return TOOL_NAME_MAP[name] ?? name;
}

/**
 * Claude Code emits snake_case tool inputs; the renderers read camelCase.
 * Renaming here keeps a single adapter instead of scattering both spellings
 * through the UI. Unlisted keys pass through untouched.
 */
const TOOL_INPUT_KEY_MAP: Record<string, string> = {
  file_path: "filePath",
  old_string: "oldString",
  new_string: "newString",
  subagent_type: "subagentType",
  replace_all: "replaceAll",
  run_in_background: "runInBackground",
  notebook_path: "notebookPath",
  new_source: "newSource",
  cell_id: "cellId",
  cell_type: "cellType",
  edit_mode: "editMode",
  output_mode: "outputMode",
};

/** Tool input keys (post-rename) that hold a path into the workspace. */
const PATH_INPUT_KEYS = new Set([
  "filePath",
  "notebookPath",
  "path",
  "cwd",
  "directory",
]);

/**
 * Rewrite an absolute workspace path as a workspace-relative one.
 *
 * Claude Code runs on the host, so it reports paths like
 * `/Users/alice/.paco/workspaces/session_x/src/app.ts`. Those are useless to the
 * client: they name a machine it can't see and they leak the operator's home
 * directory into the browser. Relative paths are also what the file-reading
 * endpoints already expect, since they resolve against the workspace root.
 *
 * Paths outside the workspace are left alone — they're genuinely absolute and
 * shortening them would misrepresent where the file is.
 */
function toWorkspaceRelative(value: string, workspaceRoot: string): string {
  const root = workspaceRoot.endsWith("/")
    ? workspaceRoot.slice(0, -1)
    : workspaceRoot;

  if (value === root) {
    return ".";
  }
  return value.startsWith(`${root}/`) ? value.slice(root.length + 1) : value;
}

/**
 * Strip the workspace root out of free text.
 *
 * Tool *results* leak the host path as prose, not as a field — the Write tool
 * answers "File created successfully at: /Users/alice/.paco/workspaces/…/a.ts",
 * and Bash echoes absolute paths in its output. Rewriting only the input fields
 * left that on screen, so the same substitution is applied to result text.
 */
export function relativizeWorkspacePaths(
  text: string,
  workspaceRoot?: string,
): string {
  if (!workspaceRoot) {
    return text;
  }

  const root = workspaceRoot.endsWith("/")
    ? workspaceRoot.slice(0, -1)
    : workspaceRoot;

  return text.split(`${root}/`).join("").split(root).join(".");
}

/**
 * Length of the trailing text that must be withheld before emitting a chunk.
 *
 * A streamed path is split across deltas at an arbitrary byte, so substituting
 * per delta misses any occurrence that straddles a boundary — in practice the
 * host path did reach the UI this way. Withholding the longest suffix that could
 * still grow into the workspace root makes the replacement boundary-safe.
 *
 * The held-back span is almost always empty, so this costs no visible latency:
 * text is only delayed when it genuinely looks like the start of the root.
 */
export function pendingRootPrefixLength(text: string, root: string): number {
  const max = Math.min(text.length, root.length - 1);
  for (let length = max; length > 0; length--) {
    if (text.endsWith(root.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

/**
 * Ceiling on a single tool result once it reaches the UI.
 *
 * Nothing bounded these before. An agent that runs `npm install` on a fresh
 * scaffold emits hundreds of kilobytes in one result; a handful of those in one
 * turn produced a message large enough that serialising it exhausted the heap
 * and killed the server mid-stream — the client saw a failed fetch and the
 * assistant's reply was never persisted.
 *
 * The sandbox's own exec path has always capped output at the same size; this
 * applies the same ceiling to results coming back from the CLI's tools.
 */
const MAX_TOOL_OUTPUT_LENGTH = 50_000;

function truncateToolText(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_LENGTH) {
    return text;
  }
  const omitted = text.length - MAX_TOOL_OUTPUT_LENGTH;
  // Keep the head: the useful signal in a long build log is at the start, and
  // the agent already has the full text in its own context.
  return `${text.slice(0, MAX_TOOL_OUTPUT_LENGTH)}\n\n… truncated ${omitted.toLocaleString()} more characters`;
}

/** Apply {@link relativizeWorkspacePaths} through a tool result of any shape. */
function relativizeToolOutput(
  output: unknown,
  workspaceRoot?: string,
): unknown {
  if (typeof output === "string") {
    return truncateToolText(relativizeWorkspacePaths(output, workspaceRoot));
  }
  if (!workspaceRoot && !Array.isArray(output) && typeof output !== "object") {
    return output;
  }
  if (Array.isArray(output)) {
    return output.map((item) => relativizeToolOutput(item, workspaceRoot));
  }
  if (output && typeof output === "object") {
    return Object.fromEntries(
      Object.entries(output as Record<string, unknown>).map(([key, value]) => [
        key,
        relativizeToolOutput(value, workspaceRoot),
      ]),
    );
  }
  return output;
}

export function normalizeToolInput(
  input: unknown,
  workspaceRoot?: string,
): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const name = TOOL_INPUT_KEY_MAP[key] ?? key;
    normalized[name] =
      workspaceRoot && typeof value === "string" && PATH_INPUT_KEYS.has(name)
        ? toWorkspaceRelative(value, workspaceRoot)
        : value;
  }
  return normalized;
}

/**
 * Translates the Claude Code protocol into AI SDK `UIMessageChunk`s.
 *
 * Stateful: block ids must be unique across a run, and the CLI reuses the same
 * `message.id` across the several `assistant` messages that make up one turn
 * (one per completed content block), so ids are minted here instead.
 *
 * Only main-thread messages are emitted. Subagent output (`parent_tool_use_id`
 * set) is deliberately dropped so the transcript shows the delegating Agent
 * tool call rather than interleaving every subagent's internal chatter.
 */
export class ClaudeUIStreamMapper {
  #blockSeq = 0;
  #openTextIds = new Set<string>();
  #openReasoningIds = new Set<string>();
  /** Maps an Anthropic content-block index to the id we minted for it. */
  #partialBlockIds = new Map<number, string>();
  /**
   * Streamed text withheld from a block because its tail could still grow into
   * the workspace root. Keyed by block id, flushed when the block closes.
   */
  #pendingText = new Map<string, string>();
  /** Host workspace root, used to shorten paths in tool inputs. */
  #workspaceRoot?: string;

  constructor(options?: { workspaceRoot?: string }) {
    this.#workspaceRoot = options?.workspaceRoot;
  }

  #nextId(prefix: string): string {
    this.#blockSeq += 1;
    return `${prefix}-${this.#blockSeq}`;
  }

  /**
   * Rewrite workspace paths in a streamed text delta.
   *
   * Emits everything that can no longer be part of a workspace path and holds
   * back the rest until the next delta, so an occurrence split across chunk
   * boundaries is still replaced. Returns the text to emit, which may be empty.
   */
  #relativizeStreamedText(id: string, delta: string): string {
    const root = this.#workspaceRoot;
    if (!root) {
      return delta;
    }

    const buffered = (this.#pendingText.get(id) ?? "") + delta;

    /*
     * Complete `root/` matches are removed first, before deciding what to hold
     * back. Order matters: `root` is itself a prefix of `root/`, so a buffer that
     * already ends in a finished `root/` would otherwise look like a partial
     * match, and the emitted part would end at the bare root — which becomes "."
     * and produced "./a.ts" where "a.ts" was correct.
     */
    const resolved = buffered.split(`${root}/`).join("");

    // What remains may still be a partial path; the next character decides
    // whether a trailing bare root becomes "." or is dropped with its slash.
    const held = pendingRootPrefixLength(resolved, `${root}/`);
    const emit =
      held > 0 ? resolved.slice(0, resolved.length - held) : resolved;

    this.#pendingText.set(id, held > 0 ? resolved.slice(-held) : "");
    return relativizeWorkspacePaths(emit, root);
  }

  /** Emit whatever a block was still holding back, and forget it. */
  #flushPendingText(id: string): string {
    const pending = this.#pendingText.get(id);
    this.#pendingText.delete(id);
    return pending
      ? relativizeWorkspacePaths(pending, this.#workspaceRoot)
      : "";
  }

  /** Map one protocol message to zero or more UI chunks. */
  map(message: ClaudeMessage): UIMessageChunk[] {
    switch (message.type) {
      case "assistant":
        return message.parent_tool_use_id
          ? []
          : this.#mapAssistant(message.message.content);

      case "user":
        return message.parent_tool_use_id
          ? []
          : this.#mapToolResults(message.message.content);

      case "stream_event":
        return message.parent_tool_use_id ? [] : this.#mapStreamEvent(message);

      case "result":
        return this.#finalize();

      default:
        return [];
    }
  }

  #mapAssistant(blocks: ClaudeContentBlock[]): UIMessageChunk[] {
    const chunks: UIMessageChunk[] = [];

    for (const block of blocks) {
      switch (block.type) {
        case "text": {
          // Already streamed via stream_event; the buffered message would
          // duplicate it.
          if (this.#openTextIds.size > 0) {
            break;
          }
          const id = this.#nextId("text");
          chunks.push(
            { type: "text-start", id },
            {
              type: "text-delta",
              id,
              delta: relativizeWorkspacePaths(block.text, this.#workspaceRoot),
            },
            { type: "text-end", id },
          );
          break;
        }

        case "thinking": {
          if (this.#openReasoningIds.size > 0) {
            break;
          }
          const id = this.#nextId("reasoning");
          chunks.push(
            { type: "reasoning-start", id },
            { type: "reasoning-delta", id, delta: block.thinking },
            { type: "reasoning-end", id },
          );
          break;
        }

        case "tool_use": {
          chunks.push(
            {
              type: "tool-input-start",
              toolCallId: block.id,
              toolName: normalizeToolName(block.name),
            },
            {
              type: "tool-input-available",
              toolCallId: block.id,
              toolName: normalizeToolName(block.name),
              input: normalizeToolInput(block.input, this.#workspaceRoot),
            },
          );
          break;
        }

        default:
          break;
      }
    }

    return chunks;
  }

  #mapToolResults(content: ClaudeContentBlock[] | string): UIMessageChunk[] {
    if (typeof content === "string") {
      return [];
    }

    const chunks: UIMessageChunk[] = [];

    for (const block of content) {
      if (block.type !== "tool_result") {
        continue;
      }

      if (block.is_error) {
        chunks.push({
          type: "tool-output-error",
          toolCallId: block.tool_use_id,
          errorText: truncateToolText(
            relativizeWorkspacePaths(
              stringifyToolContent(block.content),
              this.#workspaceRoot,
            ),
          ),
        });
      } else {
        chunks.push({
          type: "tool-output-available",
          toolCallId: block.tool_use_id,
          output: relativizeToolOutput(block.content, this.#workspaceRoot),
        });
      }
    }

    return chunks;
  }

  /** Token-level streaming, active only with `--include-partial-messages`. */
  #mapStreamEvent(message: {
    event: {
      type: string;
      index?: number;
      delta?: { type: string; text?: string; thinking?: string };
      content_block?: { type: string };
    };
  }): UIMessageChunk[] {
    const { event } = message;
    const index = event.index ?? 0;

    if (event.type === "content_block_start") {
      const blockType = event.content_block?.type;
      if (blockType === "text") {
        const id = this.#nextId("text");
        this.#partialBlockIds.set(index, id);
        this.#openTextIds.add(id);
        return [{ type: "text-start", id }];
      }
      if (blockType === "thinking") {
        const id = this.#nextId("reasoning");
        this.#partialBlockIds.set(index, id);
        this.#openReasoningIds.add(id);
        return [{ type: "reasoning-start", id }];
      }
      return [];
    }

    if (event.type === "content_block_delta") {
      const id = this.#partialBlockIds.get(index);
      if (!id) {
        return [];
      }
      if (event.delta?.type === "text_delta" && event.delta.text) {
        const delta = this.#relativizeStreamedText(id, event.delta.text);
        return delta ? [{ type: "text-delta", id, delta }] : [];
      }
      if (event.delta?.type === "thinking_delta" && event.delta.thinking) {
        return [{ type: "reasoning-delta", id, delta: event.delta.thinking }];
      }
      return [];
    }

    if (event.type === "content_block_stop") {
      const id = this.#partialBlockIds.get(index);
      if (!id) {
        return [];
      }
      this.#partialBlockIds.delete(index);

      if (this.#openTextIds.delete(id)) {
        const chunks: UIMessageChunk[] = [];
        const tail = this.#flushPendingText(id);
        if (tail) {
          chunks.push({ type: "text-delta", id, delta: tail });
        }
        chunks.push({ type: "text-end", id });
        return chunks;
      }
      if (this.#openReasoningIds.delete(id)) {
        return [{ type: "reasoning-end", id }];
      }
    }

    return [];
  }

  /** Close any block still open, so an interrupted run leaves valid state. */
  #finalize(): UIMessageChunk[] {
    const chunks: UIMessageChunk[] = [];

    for (const id of this.#openTextIds) {
      // Emit any withheld tail rather than losing the end of the message.
      const tail = this.#flushPendingText(id);
      if (tail) {
        chunks.push({ type: "text-delta", id, delta: tail });
      }
      chunks.push({ type: "text-end", id });
    }
    for (const id of this.#openReasoningIds) {
      chunks.push({ type: "reasoning-end", id });
    }

    this.#openTextIds.clear();
    this.#openReasoningIds.clear();
    this.#partialBlockIds.clear();
    this.#pendingText.clear();

    return chunks;
  }
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content === undefined || content === null) {
    return "";
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}
