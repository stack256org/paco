import type {
  DynamicToolUIPart,
  FinishReason,
  LanguageModelUsage,
  ToolUIPart,
  UIMessage,
} from "ai";
import type {
  AgentToolInput,
  AskUserQuestionInput,
  AskUserQuestionOutput,
  TaskToolOutput,
} from "@paco/claude-code";

type WebAgentStepFinishMetadata = {
  finishReason: FinishReason;
  rawFinishReason?: string;
};

export type WebAgentMessageMetadata = {
  selectedModelId?: string;
  modelId?: string;
  lastStepUsage?: LanguageModelUsage;
  totalMessageUsage?: LanguageModelUsage;
  /** Cost of the most recent step in USD, as reported by the Claude Code CLI. */
  lastStepCost?: number;
  /** Cumulative CLI-reported cost across every step of the message, in USD. */
  totalMessageCost?: number;
  lastStepFinishReason?: FinishReason;
  lastStepRawFinishReason?: string;
  stepFinishReasons?: WebAgentStepFinishMetadata[];
  /**
   * Commit the worktree was on before this turn ran.
   *
   * Present only when the turn had a repository to check point against, and
   * carried on the assistant message so "revert this turn" is anchored to the
   * turn the user is actually looking at.
   */
  checkpointSha?: string;
  /** Whether the checkpoint captured uncommitted work in a commit of its own. */
  checkpointCommitted?: boolean;
  /**
   * Set when this message was posted by a plugin's `messages:post`
   * capability (`lib/plugins/capability-handlers.ts`) rather than typed by
   * the person using the chat. The chat UI reads this to show a small
   * "via <pluginId>" badge on the message.
   */
  postedBy?: { kind: "plugin"; pluginId: string };
};

type WebAgentGitDataStatus = "pending" | "success" | "error" | "skipped";

export type WebAgentCommitData = {
  status: WebAgentGitDataStatus;
  committed?: boolean;
  pushed?: boolean;
  commitMessage?: string;
  commitSha?: string;
  url?: string;
  error?: string;
};

export type WebAgentPrData = {
  status: WebAgentGitDataStatus;
  created?: boolean;
  syncedExisting?: boolean;
  prNumber?: number;
  url?: string;
  error?: string;
  skipReason?: string;
  requiresManualCreation?: boolean;
};

type WebAgentSnippetData = {
  content: string;
  filename: string;
};

export type WebAgentWorkspaceStatusData = {
  status: "setting-up";
  message: string;
};

type WebAgentDataParts = {
  commit: WebAgentCommitData;
  pr: WebAgentPrData;
  snippet: WebAgentSnippetData;
  "workspace-status": WebAgentWorkspaceStatusData;
};

/**
 * Tool surface rendered in the transcript.
 *
 * Names are the canonical ones produced by `normalizeToolName`, not Claude
 * Code's raw tool names. Tools without a dedicated renderer arrive as dynamic
 * tool parts and need no entry here.
 */
type WebAgentUITools = {
  bash: {
    input: {
      command: string;
      description?: string;
      cwd?: string;
      detached?: boolean;
    };
    output: {
      success?: boolean;
      error?: string;
      exitCode?: number;
      stdout?: string;
      stderr?: string;
    };
  };
  read: {
    input: { filePath: string; offset?: number; limit?: number };
    output: {
      success?: boolean;
      error?: string;
      content?: string;
      totalLines?: number;
      startLine?: number;
      endLine?: number;
    };
  };
  write: {
    input: { filePath: string; content: string };
    output: { success?: boolean; error?: string };
  };
  edit: {
    input: {
      filePath: string;
      oldString: string;
      newString: string;
      replaceAll?: boolean;
    };
    output: { success?: boolean; error?: string };
  };
  glob: {
    input: { pattern: string; path?: string };
    output: { success?: boolean; error?: string; files?: string[] };
  };
  grep: {
    input: { pattern: string; path?: string; outputMode?: string };
    output: { success?: boolean; error?: string; matches?: unknown[] };
  };
  task: { input: AgentToolInput; output: TaskToolOutput };
  todo_write: { input: { todos: unknown[] }; output: unknown };
  ask_user_question: {
    input: AskUserQuestionInput;
    output: AskUserQuestionOutput;
  };
  web_fetch: {
    input: { url: string; prompt?: string; method?: string };
    output: { success?: boolean; status?: number; error?: string };
  };
  skill: {
    input: { skill: string; args?: string };
    output: { success?: boolean; error?: string };
  };
};

export type WebAgentUIMessage = UIMessage<
  WebAgentMessageMetadata,
  WebAgentDataParts,
  WebAgentUITools
>;
export type WebAgentUIMessagePart = WebAgentUIMessage["parts"][number];
export type WebAgentCommitDataPart = Extract<
  WebAgentUIMessagePart,
  { type: "data-commit" }
>;
export type WebAgentPrDataPart = Extract<
  WebAgentUIMessagePart,
  { type: "data-pr" }
>;
export type WebAgentSnippetDataPart = Extract<
  WebAgentUIMessagePart,
  { type: "data-snippet" }
>;
export type WebAgentUIToolPart =
  | DynamicToolUIPart
  | ToolUIPart<WebAgentUITools>;
