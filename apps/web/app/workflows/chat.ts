import {
  convertToModelMessages,
  type FinishReason,
  generateId as generateIdAi,
  isToolUIPart,
  type LanguageModelUsage,
  type ModelMessage,
  pruneMessages,
  type UIMessageChunk,
} from "ai";
import type { ClaudeAgentDefinition, ClaudeRunUsage } from "@paco/claude-code";
import type { TurnPolicy } from "@paco/agent-backend";
import type { SkillMetadata } from "@paco/sandbox";
import { TurnEventRecorder } from "@/lib/agent/event-recorder";
import { runAgentTurn } from "@/lib/agent/run-step";
import { appUrl } from "@/lib/app-url";
import {
  classifySetupFailure,
  setupFailureMessage,
} from "@/lib/sandbox/setup-failure-copy";
import { approvalToken } from "@/lib/agent/approvals/token";
import { normalizeBackendId } from "@/lib/agent/backend-factory";
import { getGithubToken } from "@/lib/db/github-tokens";
import {
  appendSessionEvents,
  listUnconsumedSteerEvents,
} from "@/lib/db/session-events";
import type { AgentCallOptions, SteerController } from "@/lib/agent/types";
import { resolveChatResumeToken, setChatResumeToken } from "@/lib/db/sessions";
import { getWorkflowMetadata, getWritable } from "workflow";
import { getRun } from "workflow/api";
import { assistantFileLinkPrompt } from "@/lib/assistant-file-links";
import { addLanguageModelUsage } from "./usage-utils";
import type {
  WebAgentCommitData,
  WebAgentCommitDataPart,
  WebAgentDesignProgressDataPart,
  WebAgentMessageMetadata,
  WebAgentPrData,
  WebAgentPrDataPart,
  WebAgentUIMessage,
} from "@/app/types";
import {
  claimActiveStream,
  closeStream,
  clearActiveStream,
  distillTurnMemoryStep,
  hasAutoCommitChangesStep,
  persistAssistantMessage,
  persistAssistantMessageWithToolResults,
  persistSandboxState,
  persistUserMessage,
  recordWorkflowUsage,
  refreshDiffCache,
  refreshLifecycleActivity,
  runAutoCommitStep,
  runAutoCreatePrStep,
  runTaskCompletionStep,
  sendFinish,
} from "./chat-post-finish";
import { dedupeMessageReasoning } from "@/lib/chat/dedupe-message-reasoning";
import { getChatById, getSessionById } from "@/lib/db/sessions";
import { getUserPreferences } from "@/lib/db/user-preferences";
import { APP_DEFAULT_MODEL_ID } from "@/lib/models";
import type { Session as AuthSession } from "@/lib/session/types";
import type {
  WorkflowRunStatus,
  WorkflowRunStepTiming,
} from "@/lib/db/workflow-runs";
import { resolveChatModelSelection } from "../api/chat/_lib/model-selection";
import { resolveChatSandboxRuntime } from "./chat-sandbox-runtime";
import { takeChatCheckpoint } from "./chat-checkpoint";
import type {
  DesignCandidateOutcome,
  DesignProgress,
} from "@/lib/design/design-turn";

type AuthSessionContext = Pick<AuthSession, "user"> | null;

type Options = {
  messages: WebAgentUIMessage[];
  chatId: string;
  sessionId: string;
  userId: string;
  requestUrl: string;
  authSession: AuthSessionContext;
  selectedModelId?: string;
  modelId?: string;
  agentOptions?: Omit<AgentCallOptions, "sandbox" | "skills">;
  assistantId?: string;
  inputMessagesPersisted?: boolean;
  maxSteps?: number;
  autoCommitEnabled?: boolean;
  autoPushEnabled?: boolean;
  autoCreatePrEnabled?: boolean;
  /**
   * Runs this turn as a design turn (Section 5 Task 2) instead of a normal
   * agent turn: N parallel designer candidates, each in its own worktree,
   * rather than one turn on the chat's own branch. Off (the send path's
   * default) means nothing here changes — Task 4 wires the composer toggle
   * that sets this.
   */
  mode?: "design";
  /** How many design candidates to run. Defaults to `DEFAULT_DESIGN_CANDIDATE_COUNT`. */
  designCandidateCount?: 2 | 3;
  /**
   * Refine ONE existing candidate in its own worktree instead of generating
   * a fresh set. Set by the design panel's "Iterate" control (Task 4): the
   * candidate the user annotated keeps its direction and its history, so
   * `createCandidates` — which destroys and recreates every candidate from
   * the chat's branch — must not run.
   */
  designIterateCandidate?: 1 | 2 | 3;
};

type ChatModelRuntime = {
  selectedModelId: string;
  modelId: string;
  agentOptions: Omit<AgentCallOptions, "sandbox" | "skills">;
  /** Commit the worktree after the turn — locally, whatever happens next. */
  autoCommitEnabled: boolean;
  /** Send that commit to GitHub. Implies a connected repository. */
  autoPushEnabled: boolean;
  autoCreatePrEnabled: boolean;
  /** What happens when a message arrives while this chat's turn is running. */
  turnPolicy: TurnPolicy;
};

type Writable = WritableStream<UIMessageChunk>;

const DIFF_REFRESHING_TOOL_TYPES = new Set([
  "tool-write",
  "tool-edit",
  "tool-bash",
]);

function shouldRefreshDiffCacheForParts(
  parts: WebAgentUIMessage["parts"],
): boolean {
  return parts.some(
    (part) =>
      isToolUIPart(part) &&
      DIFF_REFRESHING_TOOL_TYPES.has(part.type) &&
      (part.state === "output-available" || part.state === "output-error"),
  );
}

const convertMessages = async (
  messages: WebAgentUIMessage[],
): Promise<ModelMessage[]> => {
  "use step";
  const dedupedMessages = messages.map(dedupeMessageReasoning);
  const modelMessages = await convertToModelMessages<WebAgentUIMessage>(
    dedupedMessages,
    {
      ignoreIncompleteToolCalls: true,
      convertDataPart: (part) => {
        if (part.type === "data-snippet") {
          const { filename, content } = part.data;
          return {
            type: "text",
            text: JSON.stringify({ type: "snippet", filename, content }),
          };
        }
        return undefined;
      },
    },
  );

  return pruneMessages({
    messages: modelMessages,
    emptyMessages: "remove",
  });
};

async function resolveChatModelRuntime(params: {
  userId: string;
  sessionId: string;
  chatId: string;
  requestUrl: string;
  authSession: AuthSessionContext;
}): Promise<ChatModelRuntime> {
  "use step";

  const [sessionRecord, chat, rawPreferences] = await Promise.all([
    getSessionById(params.sessionId),
    getChatById(params.chatId),
    getUserPreferences(params.userId).catch((error) => {
      console.error("Failed to load user preferences:", error);
      return null;
    }),
  ]);

  if (!sessionRecord) {
    throw new Error("Session not found");
  }
  if (sessionRecord.userId !== params.userId) {
    throw new Error("Unauthorized");
  }
  if (!chat || chat.sessionId !== params.sessionId) {
    throw new Error("Chat not found");
  }

  const preferences = rawPreferences ? rawPreferences : null;
  const selectedModelId = chat.modelId ?? null;
  const mainModelSelection = resolveChatModelSelection({
    selectedModelId,
    effort: chat.effort,
    label: "Selected model",
  });
  /*
   * Three levels, resolved independently, because they are three different
   * risks.
   *
   * Committing writes local history: it costs nothing outside this machine and
   * turns every finished turn into a point the owner can return to, so it is on
   * unless they turned it off, and it does not care whether a repository is
   * connected. Pushing publishes to someone's GitHub account, so it stays
   * opt-in and needs somewhere to push to. A pull request is a request for
   * another person's attention, so it needs the push as well as its own flag.
   */
  const autoCommitLocalEnabled =
    sessionRecord.autoCommitLocalOverride ??
    preferences?.autoCommitLocal ??
    true;

  const hasRepo = Boolean(sessionRecord.repoOwner && sessionRecord.repoName);
  const autoPushEnabled =
    (sessionRecord.autoCommitPushOverride ??
      preferences?.autoCommitPush ??
      false) &&
    hasRepo;

  const autoCreatePrEnabled =
    autoPushEnabled &&
    (sessionRecord.autoCreatePrOverride ?? preferences?.autoCreatePr ?? false);

  return {
    selectedModelId: selectedModelId ?? mainModelSelection.id,
    modelId: mainModelSelection.id,
    agentOptions: {
      model: mainModelSelection,
      customInstructions: assistantFileLinkPrompt,
    },
    // There is nothing to push without a commit, so asking for a push asks for
    // a commit even if the local toggle is off.
    autoCommitEnabled: autoCommitLocalEnabled || autoPushEnabled,
    autoPushEnabled,
    autoCreatePrEnabled,
    turnPolicy: chat.turnPolicy ?? "steer",
  };
}

async function persistInputMessages(
  chatId: string,
  messages: WebAgentUIMessage[],
): Promise<void> {
  "use step";

  const latestMessage = messages[messages.length - 1];
  if (!latestMessage) {
    return;
  }

  await Promise.all([
    persistUserMessage(chatId, latestMessage),
    persistAssistantMessageWithToolResults(chatId, latestMessage),
  ]);
}

function buildStepTiming(
  stepNumber: number,
  startedAt: Date,
  finishedAt: Date,
  finishReason?: string,
  rawFinishReason?: string,
): WorkflowRunStepTiming {
  return {
    stepNumber,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    finishReason,
    rawFinishReason,
  };
}

function withModelMetadata(
  metadata: WebAgentMessageMetadata | undefined,
  selectedModelId: string,
  modelId: string,
): WebAgentMessageMetadata {
  return {
    ...metadata,
    selectedModelId,
    modelId,
  };
}

/**
 * What the user is told when their workspace could not be set up.
 *
 * Every cause used to arrive here as the same eleven words — "Workspace setup
 * failed. Try again in a moment." — including Docker not being installed,
 * Docker not being started, and a repository the account cannot see, none of
 * which a retry has ever fixed. The specific reasons existed but were
 * unreachable: the discriminant is thrown in one durable workflow run and read
 * in another, and only `error.message` survives that trip, so
 * `provisioningFailureReason` always answered null in production.
 *
 * `classifySetupFailure` closes that gap by reading the reason back out of the
 * text when the field is gone. The raw text still goes to the log; it never
 * reaches the user.
 */
function getSetupErrorMessage(error: unknown): string {
  // Surface the cause: a swallowed setup failure is otherwise undiagnosable
  // from the client, which only ever sees the message below.
  console.error("[chat] workspace setup failed:", error);

  return setupFailureMessage(classifySetupFailure(error));
}

function isStepTimingError(
  error: unknown,
): error is Error & { stepTiming: WorkflowRunStepTiming } {
  return (
    error instanceof Error &&
    "stepTiming" in error &&
    typeof error.stepTiming === "object" &&
    error.stepTiming !== null
  );
}

function buildGitHubCommitUrl(
  repoOwner: string,
  repoName: string,
  commitSha: string,
): string {
  return `https://github.com/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/commit/${encodeURIComponent(commitSha)}`;
}

/**
 * The commit's page on GitHub, when there is one.
 *
 * A commit that was never pushed — because pushing is off, or because the
 * session has no repository at all — has no URL to link to, and linking to one
 * anyway would send the reader to a 404.
 */
function commitUrlFor(
  result: Awaited<ReturnType<typeof runAutoCommitStep>>,
  repoOwner: string | undefined,
  repoName: string | undefined,
): string | undefined {
  if (!(result.pushed && result.commitSha && repoOwner && repoName)) {
    return undefined;
  }

  return buildGitHubCommitUrl(repoOwner, repoName, result.commitSha);
}

function buildCommitData(
  result: Awaited<ReturnType<typeof runAutoCommitStep>>,
  repoOwner: string | undefined,
  repoName: string | undefined,
): WebAgentCommitData {
  if (result.error) {
    return {
      status: "error",
      committed: result.committed,
      pushed: result.pushed,
      commitMessage: result.commitMessage,
      commitSha: result.commitSha,
      url: commitUrlFor(result, repoOwner, repoName),
      error: result.error,
    };
  }

  if (result.committed) {
    return {
      status: "success",
      committed: result.committed,
      pushed: result.pushed,
      commitMessage: result.commitMessage,
      commitSha: result.commitSha,
      url: commitUrlFor(result, repoOwner, repoName),
    };
  }

  return {
    status: "skipped",
    committed: false,
    pushed: false,
  };
}

function buildPrData(
  result: Awaited<ReturnType<typeof runAutoCreatePrStep>>,
): WebAgentPrData {
  if (result.error) {
    return {
      status: "error",
      created: result.created,
      syncedExisting: result.syncedExisting,
      prNumber: result.prNumber,
      url: result.prUrl,
      error: result.error,
    };
  }

  if (result.skipped) {
    return {
      status: "skipped",
      created: result.created,
      syncedExisting: result.syncedExisting,
      prNumber: result.prNumber,
      url: result.prUrl,
      skipReason: result.skipReason,
    };
  }

  return {
    status: "success",
    created: result.created,
    syncedExisting: result.syncedExisting,
    prNumber: result.prNumber,
    url: result.prUrl,
  };
}

/** One `data-design-progress` part per candidate, from its final outcome. */
function buildDesignProgressPart(
  outcome: DesignCandidateOutcome,
): WebAgentDesignProgressDataPart {
  return {
    type: "data-design-progress",
    id: `design-candidate-${outcome.index}`,
    data: {
      candidate: outcome.index,
      status: outcome.status,
      ...(outcome.error ? { error: outcome.error } : {}),
    },
  };
}

/** The assistant message's own text for a finished design turn. */
function buildDesignSummaryText(outcomes: DesignCandidateOutcome[]): string {
  const completedCount = outcomes.filter(
    (outcome) => outcome.status === "completed",
  ).length;

  const lines = [
    `Generated ${completedCount} of ${outcomes.length} design candidates.`,
  ];
  for (const outcome of outcomes) {
    lines.push(
      outcome.status === "completed"
        ? `- Candidate ${outcome.index}: ready${outcome.committed ? "" : " (nothing to commit)"}`
        : `- Candidate ${outcome.index}: failed — ${outcome.error ?? "unknown error"}`,
    );
  }
  return lines.join("\n");
}

function upsertAssistantDataPart(
  message: WebAgentUIMessage,
  part: WebAgentCommitDataPart | WebAgentPrDataPart,
): WebAgentUIMessage {
  const nextParts = [...message.parts];
  const existingIndex = nextParts.findIndex(
    (messagePart) =>
      messagePart.type === part.type && messagePart.id === part.id,
  );

  if (existingIndex >= 0) {
    nextParts[existingIndex] = part;
  } else {
    nextParts.push(part);
  }

  return {
    ...message,
    parts: nextParts,
  };
}

async function sendDataPart(
  writable: Writable,
  part: WebAgentCommitDataPart | WebAgentPrDataPart,
) {
  "use step";
  const writer = writable.getWriter();
  try {
    await writer.write(part);
  } finally {
    writer.releaseLock();
  }
}

/**
 * Run a design turn's N parallel candidate variants, as a workflow step.
 *
 * Everything this needs — the org's roster (for the designer persona), the
 * session workspace root, `createCandidates`, and `runDesignTurn` itself
 * (which shells out to git for the per-candidate auto-commit) — touches the
 * filesystem or the database, so it is dynamically imported here rather than
 * statically at the top of the file, exactly like `resolveWorkCwd` and
 * `resolveChatAgents` are inside `runAgentStep` below: the `"use workflow"`
 * body this feeds cannot import Node modules at all.
 *
 * Progress is streamed to the client as it happens — `onProgress` below
 * writes straight to `writable`, the same way `sendDataPart` does for the
 * commit/PR parts elsewhere in this file — so the caller only needs the
 * final `outcomes` once every candidate has finished, succeeded or not.
 *
 * A `DesignTurnAllFailedError` (every candidate failed) is caught here
 * rather than left to propagate: the outer workflow's generic error handler
 * reports "workspace setup failed" style messages meant for provisioning
 * failures, not a design turn's own per-candidate reasons.
 */
async function runDesignTurnStep(params: {
  sandboxState: AgentCallOptions["sandbox"]["state"];
  chatId: string;
  baseBranch: string;
  count: 2 | 3;
  prompt: string;
  agentOptions: AgentCallOptions;
  writable: Writable;
  /** Set to refine that one existing candidate rather than create a new set. */
  iterateCandidate?: 1 | 2 | 3;
}): Promise<{ outcomes: DesignCandidateOutcome[]; allFailed: boolean }> {
  "use step";

  const [
    { getOrganization },
    { resolveChatAgents },
    { hostWorkspaceFor },
    { createCandidates, removeCandidates, resolveCandidate },
    { runDesignTurn, DesignTurnAllFailedError, FALLBACK_DESIGNER_AGENT },
  ] = await Promise.all([
    import("@/lib/org/organization"),
    import("@/lib/agent/chat-environment"),
    import("@/lib/agent/workspace-paths"),
    import("@/lib/design/candidates"),
    import("@/lib/design/design-turn"),
  ]);

  let designerAgent = FALLBACK_DESIGNER_AGENT;
  try {
    const organization = await getOrganization();
    const roster = await resolveChatAgents(organization?.id);
    designerAgent = roster.designer ?? FALLBACK_DESIGNER_AGENT;
  } catch (error) {
    console.error(
      "[workflow] Failed to resolve the designer roster entry for a design turn; using the fallback persona:",
      error,
    );
  }

  const sessionWorkspace = hostWorkspaceFor(params.sandboxState);

  /*
   * `removeCandidates` (Task 1) is otherwise only ever reached from
   * `acceptCandidate` — the "user picked a winner" path. None of the plan's
   * three cleanup paths (accept, cancel, chat deletion) covers a design turn
   * that never produced anything to pick from: a `createCandidates` failure
   * partway through, or every candidate turn failing, both leave worktrees
   * and branches `createCandidates` already made with nothing left in this
   * codebase that will ever remove them. Every failure exit below cleans up
   * before returning or rethrowing; only the success path — where the user
   * still needs the candidates to choose from — leaves them in place.
   */
  const cleanupOrphanedCandidates = async (): Promise<void> => {
    // An iteration never cleans up. Its siblings are untouched, finished
    // work the user is still choosing between, and the candidate being
    // refined keeps whatever it had committed before this pass — removing
    // any of that because one refinement failed would throw away the whole
    // design turn on the strength of a single failed follow-up.
    if (params.iterateCandidate) {
      return;
    }
    try {
      await removeCandidates({ sessionWorkspace, chatId: params.chatId });
    } catch (cleanupError) {
      console.error(
        "[workflow] Failed to remove design candidates after a failed design turn:",
        cleanupError,
      );
    }
  };

  let candidates: Awaited<ReturnType<typeof createCandidates>>;
  if (params.iterateCandidate) {
    const existing = await resolveCandidate({
      sessionWorkspace,
      chatId: params.chatId,
      index: params.iterateCandidate,
    });
    if (!existing) {
      throw new Error(
        `Design candidate ${params.iterateCandidate} is no longer there to refine. Its worktree has been removed — start a new design turn.`,
      );
    }
    candidates = [existing];
  } else {
    try {
      candidates = await createCandidates({
        sessionWorkspace,
        chatId: params.chatId,
        baseBranch: params.baseBranch,
        count: params.count,
      });
    } catch (error) {
      await cleanupOrphanedCandidates();
      throw error;
    }
  }

  const onProgress = async (progress: DesignProgress) => {
    const writer = params.writable.getWriter();
    try {
      await writer.write({
        type: "data-design-progress",
        id: `design-candidate-${progress.candidate}`,
        data: progress,
      } satisfies WebAgentDesignProgressDataPart);
    } finally {
      writer.releaseLock();
    }
  };

  try {
    const { outcomes } = await runDesignTurn({
      candidates,
      prompt: params.prompt,
      agentOptions: params.agentOptions,
      designerAgent,
      framing: params.iterateCandidate ? "iteration" : "initial",
      onProgress,
      onChunk: () => Promise.resolve(),
    });
    return { outcomes, allFailed: false };
  } catch (error) {
    await cleanupOrphanedCandidates();
    if (error instanceof DesignTurnAllFailedError) {
      return { outcomes: error.outcomes, allFailed: true };
    }
    throw error;
  }
}

/**
 * Read buffered-but-unconsumed steer messages, as a step.
 *
 * `runAgentWorkflow`'s body runs `"use workflow"` — the Workflow SDK replays
 * it in a sandboxed VM with no Node modules, so it cannot call a Postgres
 * client directly (every other DB read/write in this file is already
 * wrapped in its own `"use step"` function for the same reason; this is the
 * continuation loop's).
 */
async function readPendingSteerStep(
  chatId: string,
): Promise<Array<{ id: number; messageId: string; text: string }>> {
  "use step";
  return listUnconsumedSteerEvents(chatId);
}

/**
 * Record that a buffered message has been consumed, as a step. See
 * `readPendingSteerStep` for why this can't be a direct call from the
 * workflow body.
 */
async function consumeSteerStep(
  chatId: string,
  messageId: string,
  mode: TurnPolicy,
): Promise<void> {
  "use step";
  await appendSessionEvents(chatId, [
    { type: "steer/consumed", messageId, mode },
  ]);
}

export async function runAgentWorkflow(options: Options) {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  const writable = getWritable<UIMessageChunk>();

  const latestMessage = options.messages.at(-1);

  if (latestMessage == null) {
    throw new Error("runAgentWorkflow requires at least one message");
  }

  const assistantId =
    latestMessage.role === "assistant"
      ? latestMessage.id
      : (options.assistantId ?? generateIdAi());

  const modelMessagesPromise = convertMessages(options.messages);
  const inputMessagesPersistPromise = options.inputMessagesPersisted
    ? Promise.resolve()
    : persistInputMessages(options.chatId, options.messages);
  const modelRuntimePromise = resolveChatModelRuntime({
    userId: options.userId,
    sessionId: options.sessionId,
    chatId: options.chatId,
    requestUrl: options.requestUrl,
    authSession: options.authSession,
  });
  const runtimePromise = resolveChatSandboxRuntime({
    userId: options.userId,
    sessionId: options.sessionId,
    chatId: options.chatId,
  });

  // Self-register this workflow's runId onto the chat as the very first step.
  // The HTTP POST handler also writes this (via compareAndSetChatActiveStreamId
  // after `start()` returns), but that write is best-effort and can be lost
  // when the client disconnects early and the function is torn down before
  // it runs. Persisting from inside the workflow guarantees that as long as
  // the workflow is running, the chat row points at it and the client can
  // resume on refresh.
  const activeStreamClaimPromise = claimActiveStream(
    options.chatId,
    workflowRunId,
    writable,
    assistantId,
  );
  const activeStreamClaim = await activeStreamClaimPromise;
  if (activeStreamClaim === "conflict") {
    // Another workflow claimed the slot while this run was queued or starting.
    // Exit before emitting chunks or persisting messages so only the owning
    // workflow can mutate this chat.
    await Promise.allSettled([
      runtimePromise,
      modelMessagesPromise,
      inputMessagesPersistPromise,
      modelRuntimePromise,
    ]);
    await closeStream(writable);
    return;
  }

  let selectedModelId = APP_DEFAULT_MODEL_ID;
  let modelId = APP_DEFAULT_MODEL_ID;

  let pendingAssistantResponse: WebAgentUIMessage =
    latestMessage.role === "assistant"
      ? {
          ...latestMessage,
          metadata: withModelMetadata(
            latestMessage.metadata,
            selectedModelId,
            modelId,
          ),
          parts: [...latestMessage.parts],
        }
      : {
          role: "assistant",
          id: assistantId,
          parts: [],
          metadata: withModelMetadata(undefined, selectedModelId, modelId),
        };

  const originalMessagesForStep: WebAgentUIMessage[] = [latestMessage];

  const runStartedAt = new Date();
  const previousResponseMessage =
    latestMessage.role === "assistant" ? latestMessage : undefined;
  const stepTimings: WorkflowRunStepTiming[] = [];
  let wasAborted = false;
  let exhaustedMaxSteps = false;
  let totalUsage: LanguageModelUsage | undefined;
  let finalFinishReason: FinishReason | undefined;
  let streamClosed = false;
  let workflowStatus: WorkflowRunStatus = "completed";
  let caughtError: unknown;
  let sandboxState: AgentCallOptions["sandbox"]["state"] | undefined;
  let shouldRefreshCachedDiff = false;
  // Collected from every completed `runTurn` call (the primary turn and each
  // continuation) for the post-turn distillation step below, which learns
  // from every turn that ran, not just the last. `sessionRepoDir` — where a
  // turn's project-scope output belongs — is the same directory for all of
  // them (it does not vary per turn), so only the latest is kept; neither
  // value can otherwise be computed in the workflow body without importing
  // sandbox/filesystem modules it must not pull in statically (see
  // `runAgentStep`'s own comment on this).
  const turnIds: string[] = [];
  let finalSessionRepoDir: string | undefined;

  try {
    const [, runtime, modelRuntime, modelMessages] = await Promise.all([
      activeStreamClaimPromise,
      runtimePromise,
      modelRuntimePromise,
      modelMessagesPromise,
      inputMessagesPersistPromise,
    ]);
    selectedModelId = options.selectedModelId ?? modelRuntime.selectedModelId;
    modelId = options.modelId ?? modelRuntime.modelId;
    pendingAssistantResponse = {
      ...pendingAssistantResponse,
      metadata: withModelMetadata(
        pendingAssistantResponse.metadata,
        selectedModelId,
        modelId,
      ),
    };

    const agentOptions: AgentCallOptions = {
      ...modelRuntime.agentOptions,
      ...options.agentOptions,
      sandbox: {
        state: runtime.sandboxState,
        workingDirectory: runtime.workingDirectory,
        hostWorkingDirectory: runtime.hostWorkingDirectory,
        currentBranch: runtime.currentBranch,
        environmentDetails: runtime.environmentDetails,
      },
      ...(runtime.skills.length > 0 ? { skills: runtime.skills } : {}),
    };
    sandboxState = runtime.sandboxState;

    /*
     * A design turn runs N parallel candidate variants in their own
     * worktrees instead of one turn on the chat's own branch — none of the
     * machinery below (the chat's own checkpoint, the continuation loop,
     * auto-commit/PR on the chat's branch, task completion, memory
     * distillation) applies, since a design turn never touches the chat's
     * worktree at all. Candidates commit themselves (`runDesignTurnStep`),
     * and Task 1's `acceptCandidate` is what eventually lands one of them on
     * this branch.
     */
    if (options.mode === "design") {
      if (!runtime.currentBranch) {
        throw new Error(
          "Design mode requires the chat's worktree branch, but none was resolved.",
        );
      }

      // `designCandidateCount`'s `2 | 3` type is compile-time only — Task 4
      // starts passing this from the client, over the wire, where nothing
      // stops an arbitrary number from arriving. Reject it here, before
      // `createCandidates` ever runs, rather than letting it reach git with
      // a `count` its own branch-naming rule (`design/<chatId>/<n>`, n =
      // 1..3) was never meant to see.
      const requestedCandidateCount = options.designCandidateCount ?? 3;
      if (requestedCandidateCount !== 2 && requestedCandidateCount !== 3) {
        throw new Error(
          `Design mode requires 2 or 3 candidates, got ${requestedCandidateCount}.`,
        );
      }

      // Same reasoning as the count above: the client picks this, so the
      // `1 | 2 | 3` type is compile-time only. An out-of-range index would
      // otherwise reach `resolveCandidate` and simply find nothing, which
      // reads as "your candidate vanished" rather than "that is not a
      // candidate index."
      const iterateCandidate = options.designIterateCandidate;
      if (
        iterateCandidate !== undefined &&
        iterateCandidate !== 1 &&
        iterateCandidate !== 2 &&
        iterateCandidate !== 3
      ) {
        throw new Error(
          `Design mode can only iterate on candidate 1, 2 or 3, got ${iterateCandidate}.`,
        );
      }

      const designResult = await runDesignTurnStep({
        sandboxState: runtime.sandboxState,
        chatId: options.chatId,
        baseBranch: runtime.currentBranch,
        count: requestedCandidateCount,
        prompt: extractLatestUserText(options.messages),
        agentOptions,
        writable,
        ...(iterateCandidate ? { iterateCandidate } : {}),
      });

      pendingAssistantResponse = {
        ...pendingAssistantResponse,
        parts: [
          {
            type: "text",
            text: buildDesignSummaryText(designResult.outcomes),
          },
          ...designResult.outcomes.map(buildDesignProgressPart),
        ],
      };

      await persistAssistantMessage(options.chatId, pendingAssistantResponse);
      await Promise.all([
        clearActiveStream(options.chatId, workflowRunId),
        sendFinish(writable).then(() => closeStream(writable)),
      ]);
      streamClosed = true;
      workflowStatus = designResult.allFailed ? "failed" : "completed";
      return;
    }

    // Before the agent touches anything, record where the worktree stands so
    // this turn can be undone. The agent edits files directly, so there is no
    // editor undo to fall back on.
    const checkpoint = await takeChatCheckpoint({
      sandboxState: runtime.sandboxState,
      chatId: options.chatId,
    });

    /*
     * One workflow step is one complete agent turn.
     *
     * This used to be a loop: the AI SDK returned control after every tool
     * call, so the server executed the tool, appended the result, and called
     * the model again. Claude Code owns that loop itself — it runs tools
     * in-process and only emits its terminal `result` message once the turn is
     * genuinely finished. There is no intermediate state to resume from, and
     * nothing new to say when resuming: continuing here sent an empty prompt,
     * which the model answered with "your message came through empty" and then
     * spun until the step cap, burning tokens on an exchange with itself.
     *
     * The agentic bound still exists, it just moved to where the loop actually
     * runs: `maxSteps` is passed to the CLI as `--max-turns`, and a run that
     * hits it comes back as `error_max_turns` → a "length" finish reason.
     */
    const turnPolicy = modelRuntime.turnPolicy;

    /**
     * Run one agent turn and fold its result into the workflow's running
     * state. Used for the primary turn and for every continuation turn that
     * consumes a buffered steer message — both go through the identical step
     * invocation (recorder, checkpointing, resume via the chat's per-backend resume token).
     *
     * Each turn gets its own assistant message id, its own seed messages, and
     * its own checkpoint. A buffered message already got its own persisted
     * row in `chatMessages` (Task 9), so the reply that answers it needs to
     * be its own row too: `getChatMessages` renders whatever rows exist for a
     * chat in insertion order, so a single, repeatedly-overwritten assistant
     * message would either discard earlier replies (the primary turn's reply
     * vanishing under a later continuation's) or leave the buffered user
     * messages without a reply of their own when the transcript loads back.
     * Retaking the checkpoint per turn (rather than sharing the primary
     * turn's) gives each turn its own revert point.
     */
    const runTurn = async (
      prompt: string,
      stepNumber: number,
      turnAssistantId: string,
      turnOriginalMessages: WebAgentUIMessage[],
      turnCheckpoint: { sha: string; dirty: boolean } | null,
    ) => {
      let stepResult: Awaited<ReturnType<typeof runAgentStep>>;

      try {
        stepResult = await runAgentStep(
          modelMessages,
          prompt,
          turnOriginalMessages,
          turnAssistantId,
          writable,
          workflowRunId,
          options.chatId,
          options.sessionId,
          options.userId,
          selectedModelId,
          modelId,
          agentOptions,
          stepNumber,
          options.maxSteps,
          turnCheckpoint,
        );
      } catch (error) {
        if (isStepTimingError(error)) {
          stepTimings.push(error.stepTiming);
        }
        throw error;
      }

      stepTimings.push(stepResult.stepTiming);
      pendingAssistantResponse =
        stepResult.responseMessage ?? pendingAssistantResponse;
      shouldRefreshCachedDiff =
        shouldRefreshCachedDiff ||
        shouldRefreshDiffCacheForParts(pendingAssistantResponse.parts);
      modelMessages.push(...stepResult.responseMessages);
      wasAborted = wasAborted || stepResult.stepWasAborted;
      finalFinishReason = stepResult.finishReason;
      exhaustedMaxSteps = stepResult.finishReason === "length";
      if (stepResult.turnId) {
        turnIds.push(stepResult.turnId);
      }
      finalSessionRepoDir = stepResult.sessionRepoDir ?? finalSessionRepoDir;

      if (stepResult.stepUsage) {
        totalUsage = totalUsage
          ? addLanguageModelUsage(totalUsage, stepResult.stepUsage)
          : stepResult.stepUsage;
      }

      if (sandboxState) {
        await refreshLifecycleActivity(options.sessionId);
      }

      // Applied here, per turn, rather than once at the end: `responseMessage`
      // above replaces the whole message object, so anything attached earlier
      // is discarded by the time the turn finishes — and each turn now has
      // its own checkpoint rather than sharing the primary turn's.
      if (turnCheckpoint) {
        pendingAssistantResponse = {
          ...pendingAssistantResponse,
          metadata: {
            ...pendingAssistantResponse.metadata,
            checkpointSha: turnCheckpoint.sha,
            checkpointCommitted: turnCheckpoint.dirty,
          },
        };
      }

      return stepResult;
    };

    // The prompt comes from the whole message list, not just the newest
    // entry: when a stopped run is resumed the newest entry is the partial
    // assistant message, and reading only that yields an empty prompt.
    let result = await runTurn(
      extractLatestUserText(options.messages),
      1,
      assistantId,
      originalMessagesForStep,
      checkpoint,
    );

    /*
     * Consume buffered messages as continuation turns, oldest first, exactly
     * once. The consumed event is appended BEFORE the continuation turn
     * runs: a crash between the two loses the buffered message rather than
     * double-running it, and durable-workflow replay of the step would
     * otherwise re-consume it. That asymmetry with the invariant is
     * deliberate — the message is still in `chatMessages` (Task 9 persisted
     * it), so nothing is lost from history, only from auto-continuation.
     *
     * A turn the user genuinely stopped (aborted, but not by steering) ends
     * the loop instead of continuing: that abort didn't come from a buffered
     * message, so nothing here should auto-resume the turn.
     *
     * `readPendingSteerStep` here and the steer monitor inside `runAgentStep`
     * agree on which message is "next" without coordinating directly: both
     * read `listUnconsumedSteerEvents`, which orders by the underlying
     * session-events row id ascending — i.e. insertion order — so the oldest
     * unconsumed message is always the same one on both sides.
     *
     * Both DB calls here go through their own `"use step"` wrapper
     * (`readPendingSteerStep`/`consumeSteerStep`) rather than calling
     * `listUnconsumedSteerEvents`/`appendSessionEvents` directly: this
     * function's body runs `"use workflow"`, which the Workflow SDK replays
     * in a sandboxed VM with no Node modules — a direct DB call here would
     * crash on every turn in production.
     */
    let nextStepNumber = 2;
    while (!result.stepWasAborted || result.stepWasSteered) {
      const pending = await readPendingSteerStep(options.chatId);
      const next = pending[0];
      if (!next) {
        break;
      }

      // This turn's reply is finished and another is about to start under a
      // new message id: persist it now, as its own row — see the comment on
      // `runTurn` above for why. The eventual final turn is persisted once
      // more below, with the enrichment (cumulative usage, auto-commit data
      // parts) that is only known once the whole exchange has finished;
      // `persistAssistantMessage` upserts by id, so re-persisting the same
      // row there is a harmless no-op for a message that hasn't changed.
      await persistAssistantMessage(options.chatId, pendingAssistantResponse);

      await consumeSteerStep(options.chatId, next.messageId, turnPolicy);

      const continuationAssistantId = generateIdAi();
      pendingAssistantResponse = {
        role: "assistant",
        id: continuationAssistantId,
        parts: [],
        metadata: withModelMetadata(undefined, selectedModelId, modelId),
      };
      const continuationOriginalMessages: WebAgentUIMessage[] = [
        {
          role: "user",
          id: next.messageId,
          parts: [{ type: "text", text: next.text }],
        },
      ];
      const continuationCheckpoint = await takeChatCheckpoint({
        sandboxState: runtime.sandboxState,
        chatId: options.chatId,
      });

      result = await runTurn(
        next.text,
        nextStepNumber,
        continuationAssistantId,
        continuationOriginalMessages,
        continuationCheckpoint,
      );
      nextStepNumber += 1;
    }

    if (totalUsage) {
      pendingAssistantResponse = {
        ...pendingAssistantResponse,
        metadata: {
          ...pendingAssistantResponse.metadata,
          totalMessageUsage: totalUsage,
        },
      };
    }

    // Persist completed model output before post-finish work so it is not lost
    // if later automation fails. Sandbox state can persist in parallel.
    await Promise.all([
      persistAssistantMessage(options.chatId, pendingAssistantResponse),
      ...(sandboxState
        ? [persistSandboxState(options.sessionId, sandboxState)]
        : []),
    ]);

    // A turn the user stopped, one that errored, and one that is waiting on a
    // tool are all unfinished: committing them would save a half-written state
    // under a message describing work that never happened.
    const finishedNaturally =
      !wasAborted &&
      finalFinishReason !== undefined &&
      finalFinishReason !== "tool-calls" &&
      finalFinishReason !== "error";
    const commitPartId = `${assistantId}:commit`;
    const prPartId = `${assistantId}:pr`;
    const repoOwner = runtime.repoOwner;
    const repoName = runtime.repoName;
    let didUpdateGitData = false;

    let autoCommitResult: Awaited<ReturnType<typeof runAutoCommitStep>> | null =
      null;

    // No repository check: a local commit needs a worktree, not a remote.
    const canAutoCommit =
      finishedNaturally &&
      (options.autoCommitEnabled ?? modelRuntime.autoCommitEnabled) &&
      sandboxState != null;

    const shouldPush =
      (options.autoPushEnabled ?? modelRuntime.autoPushEnabled) &&
      repoOwner != null &&
      repoName != null;

    if (canAutoCommit) {
      const hasAutoCommitChanges = await hasAutoCommitChangesStep({
        sandboxState,
        chatId: options.chatId,
      });

      if (hasAutoCommitChanges) {
        const pendingCommitPart: WebAgentCommitDataPart = {
          type: "data-commit",
          id: commitPartId,
          data: { status: "pending" },
        };
        pendingAssistantResponse = upsertAssistantDataPart(
          pendingAssistantResponse,
          pendingCommitPart,
        );
        await sendDataPart(writable, pendingCommitPart);
        autoCommitResult = await runAutoCommitStep({
          userId: options.userId,
          sessionId: options.sessionId,
          chatId: options.chatId,
          sessionTitle: runtime.sessionTitle,
          push: shouldPush,
          ...(repoOwner ? { repoOwner } : {}),
          ...(repoName ? { repoName } : {}),
          sandboxState,
        });

        const resolvedCommitPart: WebAgentCommitDataPart = {
          type: "data-commit",
          id: commitPartId,
          data: buildCommitData(autoCommitResult, repoOwner, repoName),
        };
        pendingAssistantResponse = upsertAssistantDataPart(
          pendingAssistantResponse,
          resolvedCommitPart,
        );
        await sendDataPart(writable, resolvedCommitPart);
        didUpdateGitData = true;
        shouldRefreshCachedDiff = true;
      } else {
        autoCommitResult = {
          committed: false,
          pushed: false,
        };
      }
    }

    const canAutoCreatePr =
      autoCommitResult != null &&
      !autoCommitResult.error &&
      (autoCommitResult.pushed || !autoCommitResult.committed);

    // A pull request needs a branch on GitHub, so it rides on the push and not
    // on the local commit.
    const autoCreatePrRequested =
      shouldPush &&
      (options.autoCreatePrEnabled ?? modelRuntime.autoCreatePrEnabled);

    if (canAutoCommit && autoCreatePrRequested) {
      if (canAutoCreatePr) {
        const pendingPrPart: WebAgentPrDataPart = {
          type: "data-pr",
          id: prPartId,
          data: { status: "pending" },
        };
        pendingAssistantResponse = upsertAssistantDataPart(
          pendingAssistantResponse,
          pendingPrPart,
        );
        await sendDataPart(writable, pendingPrPart);
        const autoPrResult = await runAutoCreatePrStep({
          userId: options.userId,
          sessionId: options.sessionId,
          chatId: options.chatId,
          sessionTitle: runtime.sessionTitle,
          repoOwner,
          repoName,
          baseBranch: runtime.baseBranch,
          sandboxState,
        });

        const resolvedPrPart: WebAgentPrDataPart = {
          type: "data-pr",
          id: prPartId,
          data: buildPrData(autoPrResult),
        };
        pendingAssistantResponse = upsertAssistantDataPart(
          pendingAssistantResponse,
          resolvedPrPart,
        );
        await sendDataPart(writable, resolvedPrPart);
        didUpdateGitData = true;
        shouldRefreshCachedDiff = true;
      } else {
        const skippedPrPart: WebAgentPrDataPart = {
          type: "data-pr",
          id: prPartId,
          data: {
            status: "skipped",
            skipReason:
              autoCommitResult?.error ??
              "Auto-commit did not leave origin in sync with HEAD",
          },
        };
        pendingAssistantResponse = upsertAssistantDataPart(
          pendingAssistantResponse,
          skippedPrPart,
        );
        await sendDataPart(writable, skippedPrPart);
        didUpdateGitData = true;
      }
    }

    if (didUpdateGitData) {
      await persistAssistantMessage(options.chatId, pendingAssistantResponse);
    }

    await Promise.all([
      clearActiveStream(options.chatId, workflowRunId),
      sendFinish(writable).then(() => closeStream(writable)),
      ...(sandboxState && shouldRefreshCachedDiff
        ? [refreshDiffCache(options.sessionId, sandboxState)]
        : []),
    ]);
    streamClosed = true;

    workflowStatus = wasAborted
      ? "aborted"
      : exhaustedMaxSteps
        ? "failed"
        : "completed";

    // After auto-commit and auto-PR, before memory distillation: the
    // client-visible stream is already closed above, so awaiting this here
    // costs the workflow run some wall-clock time but never delays the
    // user's turn. This chat may not own a task at all (the common case),
    // in which case `runTaskCompletionStep` is a no-op; when it does, this
    // is what decides whether the task fails outright or moves through the
    // reviewer gate — that decision has to land before distillation learns
    // from the turn below.
    await runTaskCompletionStep({
      chatId: options.chatId,
      isError: finalFinishReason === "error",
      finishReason: finalFinishReason ?? "unknown",
    });

    // Very end of the completion sequence, after task completion: awaiting
    // this here costs the workflow run wall-clock time but, like the step
    // above, never delays the user's turn — the stream is already closed.
    //
    // One call per turn that actually ran (the primary turn, plus every
    // continuation a steer/queue buffer produced), sequentially and awaited:
    // each turn said something different, so each is a separate thing to
    // learn from — distilling only the last would silently drop whatever the
    // earlier turns did. `sessionRepoDir` doesn't vary per turn, so the same
    // value is reused for all of them.
    if (finalSessionRepoDir) {
      for (const turnId of turnIds) {
        await distillTurnMemoryStep({
          chatId: options.chatId,
          sessionRepoDir: finalSessionRepoDir,
          userId: options.userId,
          turnId,
        });
      }
    }
  } catch (error) {
    workflowStatus = wasAborted ? "aborted" : "failed";
    caughtError = error;

    if (pendingAssistantResponse.parts.length === 0 && !streamClosed) {
      const errorText = getSetupErrorMessage(error);
      pendingAssistantResponse = {
        ...pendingAssistantResponse,
        parts: [{ type: "text", text: errorText }],
      };
      await sendTextMessage(writable, "setup-error", errorText);
      await persistAssistantMessage(options.chatId, pendingAssistantResponse);
    }
  } finally {
    try {
      // On unexpected errors, still clear the active stream and close
      // so the chat is never permanently marked as streaming.
      if (!streamClosed) {
        await Promise.all([
          clearActiveStream(options.chatId, workflowRunId),
          sendFinish(writable).then(() => closeStream(writable)),
        ]);
      }
    } finally {
      const runFinishedAt = new Date();
      await recordWorkflowUsage(
        options.userId,
        modelId,
        totalUsage,
        pendingAssistantResponse,
        previousResponseMessage,
        {
          workflowRunId,
          chatId: options.chatId,
          sessionId: options.sessionId,
          status: workflowStatus,
          startedAt: runStartedAt.toISOString(),
          finishedAt: runFinishedAt.toISOString(),
          totalDurationMs: runFinishedAt.getTime() - runStartedAt.getTime(),
          stepTimings,
        },
      );
    }
  }

  if (caughtError) {
    throw caughtError;
  }
}

/**
 * Pull the newest user turn out of the UI transcript.
 *
 * Claude Code holds the rest of the history itself, so only this text is sent.
 */
function extractLatestUserText(messages: WebAgentUIMessage[]): string {
  const lastUser = messages.findLast((message) => message.role === "user");
  if (!lastUser) {
    return "";
  }

  return lastUser.parts
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

/** Convert Claude Code usage into the AI SDK shape the UI metadata expects. */
function toLanguageModelUsage(usage: ClaudeRunUsage): LanguageModelUsage {
  const inputTokens = usage.inputTokens + usage.cachedInputTokens;
  return {
    inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: inputTokens + usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    inputTokenDetails: {
      noCacheTokens: usage.inputTokens,
      cacheReadTokens: usage.cachedInputTokens,
      cacheWriteTokens: usage.cacheCreationInputTokens,
    },
    outputTokenDetails: {
      textTokens: usage.outputTokens,
      reasoningTokens: undefined,
    },
  };
}

const runAgentStep = async (
  _messages: ModelMessage[],
  prompt: string,
  originalMessages: WebAgentUIMessage[],
  messageId: string,
  writable: Writable,
  workflowRunId: string,
  chatId: string,
  _sessionId: string,
  userId: string,
  selectedModelId: string,
  modelId: string,
  agentOptions: AgentCallOptions,
  stepNumber: number,
  /** Upper bound on the CLI's internal agentic loop (`--max-turns`). */
  maxTurns?: number,
  /**
   * Restore point taken before this turn.
   *
   * Threaded in so it rides along with the metadata that is *streamed*, not
   * just the copy that is persisted. Attaching it only at persist time meant
   * the Revert control appeared on the turn you were watching only after a
   * page reload.
   */
  checkpoint?: { sha: string; dirty: boolean } | null,
) => {
  "use step";

  const stepStartedAt = new Date();
  const abortController = new AbortController();
  const stopMonitor = startStopMonitor(workflowRunId, abortController);
  // Declared outside the try so the catch branches below can still record
  // the turn's end even though the recorder itself is created part-way
  // through the try block.
  let recorder: TurnEventRecorder | undefined;
  let steerMonitor: { stop: () => void } | undefined;
  // Registered by `runAgentTurn` (via `steerController.onSteer`) once the
  // backend handle exists. The steer monitor below may detect a buffered
  // message before that happens — memory loading and the dynamic imports
  // above it all run first — so a steer that arrives early is held in
  // `pendingSteerText` and replayed the moment `steerFn` is set.
  let steerFn: ((text: string) => Promise<void>) | undefined;
  let pendingSteerText: string | undefined;
  const triggerSteer = (text: string) => {
    if (!steerFn) {
      pendingSteerText = text;
      return;
    }
    // The backend may reject (e.g. `SteeringUnsupportedError`, or the turn
    // just finished on its own): either way this turn keeps running to
    // completion, and the buffered message stays pending — the workflow's
    // continuation loop picks it up once the turn ends naturally, exactly
    // like the queue policy does.
    void steerFn(text).catch((error) => {
      console.error(
        "[workflow] steer() failed; the turn will run to completion:",
        error,
      );
    });
  };
  // Declared outside the try for the same reason as `recorder`: the
  // abort-catch branch below also needs it, to thread through to the
  // post-turn distillation step.
  let sessionRepoDir: string | undefined;

  try {
    // Read fresh rather than threaded in from an earlier step: this step can
    // replay independently under the durable workflow runtime, and the chat's
    // current policy is what decides whether a steer monitor is armed at all.
    const chat = await getChatById(chatId);
    // Normalized through the same rule `resolveBackend` uses, so the backend
    // that RUNS the turn and the key its resume token is stored under can
    // never disagree — see `normalizeBackendId`'s doc for what diverging
    // fallbacks would cost.
    const currentBackend = normalizeBackendId(chat?.backend);
    const turnPolicy: TurnPolicy = chat?.turnPolicy ?? "steer";
    if (turnPolicy === "steer") {
      steerMonitor = startSteerMonitor(chatId, abortController, (steered) => {
        triggerSteer(steered.text);
      });
    }
    const steerController: SteerController | undefined =
      turnPolicy === "steer"
        ? {
            onSteer: (steer) => {
              steerFn = steer;
              if (pendingSteerText !== undefined) {
                const text = pendingSteerText;
                pendingSteerText = undefined;
                triggerSteer(text);
              }
            },
          }
        : undefined;

    // The backend keeps its own conversation history, so only the newest
    // user turn is sent; prior turns are recovered via this backend's own
    // resume token (`chats.resumeTokens[currentBackend]`) — scoped per
    // backend so switching a chat's backend and switching it back resumes
    // each side correctly instead of one clobbering the other (see
    // `resolveChatResumeToken`'s own doc).
    const resumeToken = chat
      ? resolveChatResumeToken(chat, currentBackend)
      : undefined;

    // Read inside the step, never returned from one. Step results are persisted
    // by the durable workflow runtime, so a token that crossed a step boundary
    // would be written to the database in clear — the one place the sealed
    // column exists to keep it out of.
    const githubToken = await getGithubToken(userId);

    /*
     * The hook posts back to this server. It runs on the same machine, so
     * localhost is right even when the app is reached through another origin.
     *
     * The port comes from APP_URL, the one place the port is
     * configured. It used to be `process.env.PORT ?? "3000"`, which happened to
     * work only because Next assigns PORT internally after binding — and the
     * default of 3000 was wrong for this app, which serves 3066. That matters
     * more than it looks: the approval hook fails *open* on a transport error
     * by design, so a callback aimed at a closed port would not error loudly.
     * It would silently approve every tool call.
     */
    const approvalUrl = `http://127.0.0.1:${appUrl().port || "80"}/api/internal/approvals`;

    recorder = new TurnEventRecorder(chatId, crypto.randomUUID());
    await recorder.start({ messageId, prompt, policy: turnPolicy });
    recorder.assertPromptLogged(prompt);

    /*
     * The session's repository directory — not the chat's worktree — is
     * resolved once here and reused below for both memory retrieval and (via
     * this step's return value) the post-turn distillation step: project
     * memory lives in the session repo so it's shared across a session's
     * chats, not scoped to one.
     *
     * Dynamically imported: this touches the filesystem and the sandbox
     * package, which the "use workflow" function in this file must not pull
     * in statically (see `chat-sandbox-runtime.ts`'s `hostWorkingDirectory`
     * comment) — the same reason `chat-post-finish.ts` defers its own
     * sandbox/memory imports to inside each step body.
     */
    try {
      const { resolveWorkCwd } = await import("@/lib/agent/workspace-paths");
      sessionRepoDir = resolveWorkCwd(agentOptions.sandbox.state);
    } catch (error) {
      console.error("[workflow] Failed to resolve session repo dir:", error);
    }

    /*
     * Memory is additive context, never a turn dependency (see the plan's
     * memory invariants): a failed load must never block or fail the turn,
     * so loading the org and retrieving memory is wrapped in one try/catch
     * and simply leaves `memorySection` unset on any failure.
     *
     * Not gated on `sessionRepoDir`: only project-scope memory lives under
     * it, and user/org scope don't — a chat whose repo dir failed to resolve
     * above still has a user (and usually an organisation), so it would be
     * wrong to drop all three scopes over the one that needs a directory.
     * `loadMemorySectionForTurn` skips project scope on its own when
     * `sessionRepoDir` is absent.
     *
     * Loaded fresh every turn, right here rather than threaded in from an
     * earlier step, for the same reason the roster/skills are: this step can
     * replay independently under the durable workflow runtime, and memory
     * written since the last turn (a distillation, a manual edit, a
     * promotion) should be visible to this one.
     */
    let memorySection: string | undefined;
    /*
     * The subagent roster and plugin skill contributions, resolved fresh per
     * turn right alongside memory above and for the same reason: this step
     * can replay independently under the durable workflow runtime, so a
     * roster edit or a plugin toggle since the last turn should be visible
     * on this one rather than stuck at whatever `resolveChatSandboxRuntime`
     * saw when the workflow started.
     *
     * Additive, never a turn dependency, exactly like memory: a failure here
     * leaves both `undefined`, so the turn falls back to whatever
     * `agentOptions` already carried — `run-step.ts`'s package-level
     * `DEFAULT_AGENTS` when `agents` is unset, and the workspace-only skills
     * `resolveChatSandboxRuntime` found.
     */
    let resolvedAgents: Record<string, ClaudeAgentDefinition> | undefined;
    let resolvedSkills: SkillMetadata[] | undefined;
    /**
     * Plugin-contributed MCP servers for this turn (`--mcp-config`). Same
     * degrade-to-undefined posture as the roster/skills resolvers right
     * below: `resolveChatMcpServers` never throws on its own (it already
     * catches everything internally), but it's resolved inside this same
     * try/catch anyway so one dynamic import failing before it runs doesn't
     * leave this whole block half-finished.
     */
    let resolvedMcpServers: AgentCallOptions["mcpServers"] | undefined;
    try {
      const [
        { getOrganization },
        { loadMemorySectionForTurn },
        { resolveChatAgents, resolveChatMcpServers, resolveChatSkills },
      ] = await Promise.all([
        import("@/lib/org/organization"),
        import("@/lib/memory/load-for-turn"),
        import("@/lib/agent/chat-environment"),
      ]);
      const organization = await getOrganization();
      memorySection = await loadMemorySectionForTurn({
        ...(sessionRepoDir ? { sessionRepoDir } : {}),
        userId,
        organizationId: organization?.id,
        prompt,
      });
      // `resolveChatAgents` treats `organizationId` as optional — plugin
      // agent contributions don't need one, only the roster half does — so
      // this always runs rather than being gated on `organization` existing.
      resolvedAgents = await resolveChatAgents(organization?.id);
      resolvedSkills = await resolveChatSkills(agentOptions.skills ?? []);
      resolvedMcpServers = await resolveChatMcpServers();
    } catch (error) {
      console.error(
        "[workflow] Failed to load memory/roster/skills for turn:",
        error,
      );
    }

    const step = await runAgentTurn<WebAgentUIMessage>({
      prompt,
      options: {
        ...agentOptions,
        ...(memorySection ? { memorySection } : {}),
        ...(resolvedAgents ? { agents: resolvedAgents } : {}),
        ...(resolvedSkills ? { skills: resolvedSkills } : {}),
        ...(resolvedMcpServers ? { mcpServers: resolvedMcpServers } : {}),
      },
      messageId,
      originalMessages,
      // `claudeSessionId` is `runAgentTurn`'s neutral resume-token field
      // (see its own doc — the name predates OpenFX and is not renamed
      // here) fed with THIS backend's own token, never the other one's.
      ...(resumeToken ? { claudeSessionId: resumeToken } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(githubToken ? { githubToken } : {}),
      chatId,
      // `chat` was already read above (for `turnPolicy`); reusing it here
      // means this turn runs on whichever backend the chat is actually set
      // to, resolved via `resolveBackend` (`backend-factory.ts`).
      chatBackend: chat?.backend,
      approval: { url: approvalUrl, token: approvalToken() },
      abortSignal: abortController.signal,
      ...(steerController ? { steerController } : {}),
      onChunk: async (chunk) => {
        const writer = writable.getWriter();
        try {
          await writer.write(chunk);
        } finally {
          writer.releaseLock();
        }
        // Narrowing doesn't cross the closure boundary here; recorder is
        // always assigned by the time onChunk runs.
        recorder?.chunk(chunk);
      },
    });

    await recorder.finish({
      finishReason: step.finishReason,
      isError: step.isError,
      usage: step.usage,
      costUsd: step.costUsd,
      ...(step.steered ? { steered: step.steered } : {}),
    });

    // Persist the resume token under the backend that produced it, so the
    // next turn on that SAME backend resumes instead of starting over — and
    // a turn on the OTHER backend never sees it (see
    // `resolveChatResumeToken`'s own doc on why that matters).
    if (step.claudeSessionId && step.claudeSessionId !== resumeToken) {
      await setChatResumeToken(chatId, currentBackend, step.claudeSessionId);
    }

    const stepUsage = toLanguageModelUsage(step.usage);
    const stepFinishedAt = new Date();

    const stepMetadata = {
      selectedModelId,
      modelId,
      lastStepUsage: stepUsage,
      totalMessageUsage: stepUsage,
      lastStepCost: step.costUsd,
      totalMessageCost: step.costUsd,
      lastStepFinishReason: step.finishReason,
      stepFinishReasons: [{ finishReason: step.finishReason }],
      ...(checkpoint
        ? {
            checkpointSha: checkpoint.sha,
            checkpointCommitted: checkpoint.dirty,
          }
        : {}),
    } satisfies WebAgentMessageMetadata;

    // Stream the metadata so the client can show live token and cost counts
    // instead of waiting for the message to be persisted.
    {
      const writer = writable.getWriter();
      try {
        await writer.write({
          type: "message-metadata",
          messageMetadata: stepMetadata,
        });
      } finally {
        writer.releaseLock();
      }
    }

    let responseMessage = step.responseMessage;
    if (responseMessage) {
      responseMessage = {
        ...responseMessage,
        metadata: {
          ...withModelMetadata(
            responseMessage.metadata,
            selectedModelId,
            modelId,
          ),
          ...stepMetadata,
        } satisfies WebAgentMessageMetadata,
      };
    }

    return {
      responseMessage,
      // Claude Code owns the transcript, so nothing is fed back into the
      // model-message list.
      responseMessages: [] as ModelMessage[],
      finishReason: step.finishReason,
      rawFinishReason: undefined,
      stepUsage,
      stepCost: step.costUsd,
      stepWasAborted: false,
      // Steering now goes through the backend's own `steer()` (see
      // `steerController` above), which winds the turn down cleanly and
      // resolves here — it never throws — so a steered turn is recognized
      // from `step.steered` on this success path, not from an abort.
      stepWasSteered: Boolean(step.steered),
      stepTiming: buildStepTiming(
        stepNumber,
        stepStartedAt,
        stepFinishedAt,
        step.finishReason,
      ),
      // Threaded out for the post-turn distillation step, which runs from
      // the workflow body once the whole turn (including any continuations)
      // has finished — not from inside this step.
      turnId: recorder?.getTurnId(),
      sessionRepoDir,
    };
  } catch (error) {
    const stepFinishedAt = new Date();

    if (isAbortError(error)) {
      // Steering never reaches this branch (see the comment on
      // `stepWasSteered` above): an abort here is always the stop button, via
      // `startStopMonitor`.
      const abortedFinishReason: FinishReason = "stop";

      await recorder?.finish({ finishReason: "stop", isError: false });
      return {
        responseMessage: undefined,
        responseMessages: [] as ModelMessage[],
        finishReason: abortedFinishReason,
        rawFinishReason: undefined,
        stepUsage: undefined,
        stepCost: undefined,
        stepWasAborted: true,
        stepWasSteered: false,
        stepTiming: buildStepTiming(
          stepNumber,
          stepStartedAt,
          stepFinishedAt,
          abortedFinishReason,
        ),
        turnId: recorder?.getTurnId(),
        sessionRepoDir,
      };
    }

    await recorder?.finish({ finishReason: "error", isError: true });

    const errorWithStepTiming =
      error instanceof Error ? error : new Error(String(error));
    Object.assign(errorWithStepTiming, {
      stepTiming: buildStepTiming(
        stepNumber,
        stepStartedAt,
        stepFinishedAt,
        "error" as FinishReason,
      ),
    });
    throw errorWithStepTiming;
  } finally {
    stopMonitor.stop();
    steerMonitor?.stop();
  }
};

function startStopMonitor(runId: string, abortController: AbortController) {
  let shouldStop = false;

  const done = (async () => {
    const run = getRun(runId);

    while (!shouldStop && !abortController.signal.aborted) {
      let runStatus:
        | "pending"
        | "running"
        | "completed"
        | "failed"
        | "cancelled";

      try {
        runStatus = await run.status;
      } catch {
        await delay(150);
        continue;
      }

      if (runStatus === "cancelled") {
        abortController.abort();
        return;
      }

      await delay(150);
    }
  })();

  return {
    stop() {
      shouldStop = true;
    },
    done,
  };
}

/**
 * Polls for steer/buffered events during a turn (steer policy only) and
 * hands the caller the buffered message once one arrives, so it can steer
 * the backend directly (see `steerController` in `runAgentStep`) instead of
 * aborting the turn — the workflow loop then consumes the buffer as a
 * continuation turn. Same polling/cleanup lifecycle as `startStopMonitor`;
 * `abortController` here only stops polling once the turn ends for some
 * other reason (a genuine user stop), it is never `.abort()`-ed by this
 * function itself.
 *
 * `onSteerDetected` is handed the buffered message, not just a boolean: the
 * caller needs its text to actually steer with, and re-querying after the
 * fact would race the workflow's own consumption loop over which message is
 * "next" (both agree because both read `listUnconsumedSteerEvents`, which
 * orders by insertion id).
 */
function startSteerMonitor(
  chatId: string,
  abortController: AbortController,
  onSteerDetected: (steered: { messageId: string; text: string }) => void,
) {
  let shouldStop = false;

  const poll = async () => {
    while (!shouldStop && !abortController.signal.aborted) {
      try {
        const pending = await listUnconsumedSteerEvents(chatId);
        const next = pending[0];
        if (next) {
          onSteerDetected(next);
          return;
        }
      } catch {
        // Polling must never kill a turn; try again next tick.
      }
      await delay(1000);
    }
  };

  void poll();

  return {
    stop() {
      shouldStop = true;
    },
  };
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

async function sendTextMessage(writable: Writable, id: string, text: string) {
  "use step";
  const writer = writable.getWriter();
  try {
    await writer.write({ type: "text-start", id });
    await writer.write({ type: "text-delta", id, delta: text });
    await writer.write({ type: "text-end", id });
  } finally {
    writer.releaseLock();
  }
}
