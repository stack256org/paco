import "server-only";

import type { AgentBackend, TurnUsage } from "@paco/agent-backend";
import {
  buildApprovalSettings,
  type ClaudeAgentDefinition,
  type ClaudeBackendOptions,
  ClaudeCodeBackend,
  DEFAULT_AGENTS,
} from "@paco/claude-code";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { buildAppendSystemPrompt } from "./system-prompt";
import type { AgentCallOptions, SteerController } from "./types";
import { hostWorkspaceFor } from "./workspace-paths";

export interface AgentStepResult<UI extends UIMessage> {
  responseMessage?: UI;
  usage: TurnUsage;
  finishReason: "stop" | "length" | "error" | "tool-calls";
  /** Claude Code session id, to persist for the next turn's `--resume`. */
  claudeSessionId: string;
  costUsd?: number;
  isError: boolean;
  /** Set when the turn ended because the caller steered it mid-run. */
  steered?: { text: string };
  /** Parsed result when `options.structuredOutput` was set for this turn. */
  structuredOutput?: unknown;
}

/**
 * Resolve the host path the CLI runs in.
 *
 * Claude Code runs on the host, not inside the container, so its cwd is the
 * bind-mounted workspace directory rather than the container's `/workspace`.
 */
/**
 * The host directory Claude Code runs in.
 *
 * This is the chat's worktree, not the session's repository. The agent runs on
 * the host, so the directory it starts in decides which branch its edits land
 * on — pointing it at the repository would put every chat's work on the same
 * branch regardless of the worktrees existing on disk.
 */
function resolveHostCwd(options: AgentCallOptions): string {
  if (options.sandbox.hostWorkingDirectory) {
    return options.sandbox.hostWorkingDirectory;
  }
  return hostWorkspaceFor(options.sandbox.state);
}

/**
 * The subagent roster.
 *
 * Returned as-is. There used to be a `subagentModel` override that rewrote
 * every agent's model to one value, which meant choosing a subagent model in
 * settings collapsed explorer and executor onto the same tier — removing the
 * only thing the roster does.
 */
function resolveAgents(
  options: AgentCallOptions,
): Record<string, ClaudeAgentDefinition> {
  return options.agents ?? DEFAULT_AGENTS;
}

/**
 * Run one agent turn against the sandbox workspace.
 *
 * Each chunk is written out as it arrives and simultaneously fed to
 * `readUIMessageStream`, so the client streams live while the persisted
 * assistant message is reconstructed in the same pass.
 */
export async function runAgentTurn<UI extends UIMessage>(params: {
  prompt: string;
  options: AgentCallOptions;
  messageId: string;
  originalMessages: UI[];
  claudeSessionId?: string;
  maxTurns?: number;
  /**
   * The user's GitHub token, so the agent's `gh` acts as them.
   *
   * Without it the CLI falls back to the host's keyring login, and the agent
   * would push and open pull requests as whoever set up the machine rather
   * than as the person whose session it is.
   */
  githubToken?: string;
  /** Chat id, so the approval hook can say which chat is asking. */
  chatId?: string;
  /** Where the hook posts, and the secret it authenticates with. */
  approval?: { url: string; token: string };
  abortSignal?: AbortSignal;
  /**
   * Registers a `steer(text)` function with the caller once the backend
   * handle exists, so a running turn can be steered through the backend's
   * own contract instead of `abortSignal` (see `SteerController`'s doc).
   */
  steerController?: SteerController;
  onChunk: (chunk: UIMessageChunk) => Promise<void>;
  backend?: AgentBackend;
}): Promise<AgentStepResult<UI>> {
  const { options } = params;

  const appendSystemPrompt = buildAppendSystemPrompt({
    environmentDetails: options.sandbox.environmentDetails,
    currentBranch: options.sandbox.currentBranch,
    customInstructions: options.customInstructions,
    skills: options.skills,
    hasGithubToken: params.githubToken !== undefined,
    memorySection: options.memorySection,
  });

  const backendOptions: ClaudeBackendOptions = {
    ...(params.approval && params.chatId
      ? { settings: buildApprovalSettings() }
      : {}),
    env: {
      ...(params.githubToken
        ? {
            GH_TOKEN: params.githubToken,
            GITHUB_TOKEN: params.githubToken,
          }
        : {}),
      // Read by the PreToolUse hook, which runs as its own process and has
      // no other way to know where Paco is or who it is acting for.
      ...(params.approval && params.chatId
        ? {
            PACO_APPROVAL_URL: params.approval.url,
            PACO_APPROVAL_TOKEN: params.approval.token,
            PACO_APPROVAL_CHAT_ID: params.chatId,
          }
        : {}),
    },
    model: options.model?.id,
    ...(options.model?.effort && { effort: options.model.effort }),
    agents: resolveAgents(options),
    ...(appendSystemPrompt && { appendSystemPrompt }),
    ...(options.structuredOutput && {
      jsonSchema: options.structuredOutput.jsonSchema,
    }),
    ...(options.tools && { tools: options.tools }),
    ...(options.disallowedTools && {
      disallowedTools: options.disallowedTools,
    }),
    /*
     * The run is non-interactive, so anything that asks for approval is simply
     * refused — there is no one to ask.
     *
     * `acceptEdits` sounds right but only covers file edits: the CLI still
     * gates Bash, so the agent could write an app and then fail to install,
     * build, or serve it. That was observed — it tried four times to start a
     * dev server and gave up. `dontAsk` is worse, denying Bash outright.
     *
     * Bypassing the CLI's own prompts does not mean nothing is checked.
     * A `PreToolUse` hook fires even in this mode, and Paco routes every
     * tool call through it: reads and in-worktree edits proceed untouched,
     * while anything that reaches outside the worktree or is destructive
     * stops and asks the user. That is the approval an interactive session
     * would give, without the modes that make the product unusable —
     * `acceptEdits` gates Bash, so the agent could write an app and then not
     * be allowed to start it, and `dontAsk` denies Bash outright.
     */
    permissionMode: "bypassPermissions",
    // Resume keeps the CLI's own history so the full transcript is not
    // replayed on every turn.
    // --session-id requires a UUID; message ids are nanoids, so mint one.
    ...(params.claudeSessionId ? {} : { sessionId: crypto.randomUUID() }),
    ...(params.maxTurns !== undefined && { maxTurns: params.maxTurns }),
    includePartialMessages: true,
  };

  const backend = params.backend ?? new ClaudeCodeBackend();
  const handle = backend.startTurn({
    cwd: resolveHostCwd(options),
    prompt: params.prompt,
    ...(params.claudeSessionId ? { resumeToken: params.claudeSessionId } : {}),
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    backendOptions,
  });
  // Handed to the caller synchronously, before any chunk is read: a caller
  // that wants to steer as soon as possible (the workflow's monitor may
  // already have something buffered) shouldn't have to wait for the stream
  // to start.
  params.steerController?.onSteer((text) => handle.steer(text));

  const stream = new ReadableStream<UIMessageChunk>({
    async start(controller) {
      try {
        for await (const chunk of handle.chunks) {
          await params.onChunk(chunk);
          controller.enqueue(chunk);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  let responseMessage: UI | undefined;
  const lastOriginal = params.originalMessages.at(-1);

  for await (const message of readUIMessageStream<UI>({
    stream,
    ...(lastOriginal?.role === "assistant" ? { message: lastOriginal } : {}),
  })) {
    responseMessage = message;
  }

  const result = await handle.result;

  /*
   * Stamp the caller's id on the reconstructed message.
   *
   * `readUIMessageStream` takes the id from the stream's `start` chunk, but that
   * chunk is written by the workflow around this call — the chunks fed in here
   * begin at the first content block. Left alone the message comes back with an
   * empty id, and since assistant messages are persisted with an upsert keyed on
   * it, every turn in a chat overwrote the same row and the history collapsed to
   * one entry.
   *
   * When a prior assistant message is being continued its id is already the same
   * value, so assigning unconditionally is safe.
   */
  return {
    responseMessage: responseMessage
      ? { ...responseMessage, id: params.messageId }
      : undefined,
    usage: result.usage,
    finishReason: result.finishReason,
    // `ClaudeCodeBackend` always sets `resumeToken` from the CLI's terminal
    // message; the `?? ""` is only a type-narrowing fallback for the neutral
    // `TurnResult` shape, where it is optional for backends that don't resume.
    claudeSessionId: result.resumeToken ?? "",
    costUsd: result.costUsd,
    isError: result.isError,
    ...(result.steered ? { steered: result.steered } : {}),
    ...(result.structuredOutput !== undefined
      ? { structuredOutput: result.structuredOutput }
      : {}),
  };
}
