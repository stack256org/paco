import type { UIToolInvocation } from "ai";

/**
 * Input/output shapes for the Claude Code built-in tools the UI renders.
 *
 * These mirror the CLI's own tool schemas so the renderers can type tool calls
 * arriving over the stream-json protocol.
 */

export interface AskUserQuestionOption {
  /** Display text for the choice (concise, 1-5 words). */
  label: string;
  /** What picking this option means or implies. */
  description: string;
  /** Optional preview (mockup, code snippet) rendered when focused. */
  preview?: string;
}

export interface AskUserQuestionEntry {
  /** The full question text. */
  question: string;
  /** Short chip label, max ~12 chars. */
  header: string;
  /** 2-4 mutually exclusive choices. */
  options: AskUserQuestionOption[];
  /** Allow selecting more than one option. */
  multiSelect?: boolean;
}

export interface AskUserQuestionInput {
  /** 1-4 questions presented as tabs. */
  questions: AskUserQuestionEntry[];
}

export type AskUserQuestionAnswerValue = string | string[];

export type AskUserQuestionOutput =
  | { answers: Record<string, AskUserQuestionAnswerValue> }
  | { declined: true };

/** Input for the `Agent` tool, which delegates work to a subagent. */
export interface AgentToolInput {
  /** Short label shown to the user. */
  description: string;
  /** Alias of `description`, used by the transcript renderer. */
  task?: string;
  /** Full instructions for the subagent. */
  prompt: string;
  /** Which registered subagent to run (normalized from `subagent_type`). */
  subagentType?: string;
  /** Per-call model override; inherits the parent model when omitted. */
  model?: "sonnet" | "opus" | "haiku";
  /** Resume a previous subagent transcript. */
  resume?: string;
  /** Run detached and report via an output file. */
  run_in_background?: boolean;
}

/**
 * A tool call a subagent is currently running.
 *
 * Populated only when subagent progress is being forwarded; the CLI reports a
 * subagent's own tool calls with `parent_tool_use_id` set.
 */
export interface TaskPendingToolCall {
  name: string;
  input: unknown;
}

/** Aggregated state for one `Agent` tool invocation. */
export interface TaskToolOutput {
  /** Final assistant messages from the subagent, when forwarded. */
  final?: unknown;
  /** Token usage reported for the subagent run. */
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Tool call the subagent is currently running, if known. */
  pending?: TaskPendingToolCall;
  /** Number of tool calls the subagent has made. */
  toolCallCount?: number;
  /** Epoch ms when the subagent started, for elapsed-time display. */
  startedAt?: number;
  /** Model the subagent ran on. */
  modelId?: string;
  /** Final text the subagent returned. */
  result?: string;
}

export type TaskTool = {
  input: AgentToolInput;
  output: TaskToolOutput;
};

export type TaskToolUIPart = UIToolInvocation<TaskTool>;
