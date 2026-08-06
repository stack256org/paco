export {
  type ClaudeAgentStream,
  type ClaudeRunUsage,
  collectMessages,
  streamClaudeAgent,
  toFinishReason,
  toRunUsage,
} from "./agent.ts";
export {
  generateObject,
  generateText,
  type GenerateTextOptions,
} from "./generate.ts";
export type {
  AgentToolInput,
  AskUserQuestionAnswerValue,
  AskUserQuestionEntry,
  AskUserQuestionInput,
  AskUserQuestionOption,
  AskUserQuestionOutput,
  TaskPendingToolCall,
  TaskTool,
  TaskToolOutput,
  TaskToolUIPart,
} from "./tool-types.ts";
export {
  buildArgs,
  type ClaudeAgentDefinition,
  type ClaudeCodeOptions,
  DEFAULT_AGENTS,
  type ModelTier,
  type PermissionMode,
} from "./options.ts";
export { ClaudeCodeError, type ClaudeCodeRun, runClaudeCode } from "./run.ts";
export type {
  ClaudeApiRetryMessage,
  ClaudeAssistantMessage,
  ClaudeContentBlock,
  ClaudeInitMessage,
  ClaudeMessage,
  ClaudeModelUsage,
  ClaudeRateLimitMessage,
  ClaudeResultMessage,
  ClaudeStreamEventMessage,
  ClaudeUsage,
  ClaudeUserMessage,
} from "./types.ts";
export { isAssistantMessage, isInitMessage, isResultMessage } from "./types.ts";
export {
  ClaudeUIStreamMapper,
  normalizeToolInput,
  normalizeToolName,
} from "./ui-stream.ts";

// tool approval: which calls need a human, and the hook that asks
export {
  type ApprovalDecision,
  decideApproval,
  type ToolCall,
} from "./approval-policy.ts";
export { buildApprovalSettings } from "./approval.ts";
export { compactSession, type CompactOutcome } from "./compact.ts";
