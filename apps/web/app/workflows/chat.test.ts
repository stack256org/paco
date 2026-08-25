import { ProvisioningError } from "@/lib/sandbox/provisioning-errors";
import { setupFailureMessage } from "@/lib/sandbox/setup-failure-copy";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { UIMessageChunk } from "ai";

/*
 * The workflow builds the approval hook's callback URL from the app's own
 * origin, so it needs one. `appUrl()` throws rather than guessing — a wrong
 * port there would point the tool-approval hook at nothing, and the hook fails
 * open, so every tool call would be approved without anyone being asked.
 */
process.env.APP_URL ??= "http://localhost:3066";

// The workflow now reads the user's GitHub token, which reaches the
// server-only marker package through the sealed-secret helper.
mock.module("server-only", () => ({}));
mock.module("@/lib/db/github-tokens", () => ({
  getGithubToken: async () => null,
}));

// The workflow now records session events for every turn via
// TurnEventRecorder, which appends through this module. Stub it so the
// workflow tests stay hermetic instead of touching a real Postgres client.
//
// `pendingSteerEvents` also backs `listUnconsumedSteerEvents`, so both the
// steer monitor's polling and the workflow's own continuation loop read the
// same in-memory buffer a test primes with `bufferSteerMessage`.
type PendingSteerEvent = { id: number; messageId: string; text: string };
let pendingSteerEvents: PendingSteerEvent[] = [];
let nextSteerEventId = 1;

function bufferSteerMessage(messageId: string, text: string) {
  pendingSteerEvents = [
    ...pendingSteerEvents,
    { id: nextSteerEventId++, messageId, text },
  ];
}

const appendSessionEventsSpy = mock(
  async (_chatId: string, events: Array<Record<string, unknown>>) => {
    for (const event of events) {
      if (
        event.type === "steer/consumed" &&
        typeof event.messageId === "string"
      ) {
        pendingSteerEvents = pendingSteerEvents.filter(
          (pending) => pending.messageId !== event.messageId,
        );
      }
    }
  },
);
const listUnconsumedSteerEventsSpy = mock(() =>
  Promise.resolve(pendingSteerEvents),
);

mock.module("@/lib/db/session-events", () => ({
  appendSessionEvents: appendSessionEventsSpy,
  listUnconsumedSteerEvents: listUnconsumedSteerEventsSpy,
}));

// ── Spy state ──────────────────────────────────────────────────────

const writtenChunks: UIMessageChunk[] = [];
let runStatus: string = "running";

type TestResolvedChatSandboxRuntime = {
  sandboxState: {
    type: "docker";
    sandboxName: string;
    expiresAt: number;
  };
  workingDirectory: string;
  currentBranch: string;
  environmentDetails: string;
  skills: never[];
  didSetupWorkspace: boolean;
  sessionTitle: string;
  repoOwner?: string;
  repoName?: string;
};

function createResolvedChatSandboxRuntime(
  overrides: Partial<TestResolvedChatSandboxRuntime> = {},
): TestResolvedChatSandboxRuntime {
  return {
    sandboxState: {
      type: "docker",
      sandboxName: "session_session-1",
      expiresAt: Date.now() + 60_000,
    },
    workingDirectory: "/workspace",
    currentBranch: "main",
    environmentDetails: "test sandbox",
    skills: [],
    didSetupWorkspace: false,
    sessionTitle: "Session title",
    repoOwner: "acme",
    repoName: "repo",
    ...overrides,
  };
}

/**
 * Records the order `runTaskCompletionStep` and `distillTurnMemoryStep` are
 * called in, across a whole workflow run — the reviewer gate has to decide
 * the task's fate before distillation learns from the turn, per Task 6.
 * Bun's separate mock objects don't share a call-order timeline on their
 * own, so this array is what the ordering test in this file reads.
 */
let completionSequenceCallOrder: string[] = [];

const spies = {
  persistUserMessage: mock(() => Promise.resolve()),
  persistAssistantMessageWithToolResults: mock(() => Promise.resolve()),
  persistAssistantMessage: mock((_chatId?: unknown, _message?: unknown) =>
    Promise.resolve(),
  ),
  persistSandboxState: mock((_sessionId?: unknown, _sandboxState?: unknown) =>
    Promise.resolve(),
  ),
  resolveChatSandboxRuntime: mock((_params: { assistantId?: string }) => {
    return Promise.resolve(createResolvedChatSandboxRuntime());
  }),
  claimActiveStream: mock(
    async (
      _chatId?: unknown,
      _workflowRunId?: unknown,
      writable?: WritableStream<UIMessageChunk>,
      messageId?: string,
    ) => {
      if (writable && messageId) {
        const writer = writable.getWriter();
        try {
          await writer.write({ type: "start", messageId });
        } finally {
          writer.releaseLock();
        }
      }
      return "claimed";
    },
  ),
  closeStream: mock((writable: WritableStream<UIMessageChunk>) =>
    writable.close(),
  ),
  clearActiveStream: mock((_chatId?: unknown, _workflowRunId?: unknown) =>
    Promise.resolve(),
  ),
  sendFinish: mock(async (writable: WritableStream<UIMessageChunk>) => {
    const writer = writable.getWriter();
    try {
      await writer.write({ type: "finish", finishReason: "stop" });
    } finally {
      writer.releaseLock();
    }
  }),
  recordWorkflowUsage: mock(() => Promise.resolve()),
  refreshDiffCache: mock((_sessionId?: unknown, _sandboxState?: unknown) =>
    Promise.resolve(),
  ),
  refreshLifecycleActivity: mock(() => Promise.resolve()),
  hasAutoCommitChangesStep: mock(() => Promise.resolve(true)),
  // Typed loosely on purpose: the tests read `push` and `repoOwner` off the
  // recorded call to check which of the three levels the workflow asked for.
  runAutoCommitStep: mock((_params?: { push?: boolean; repoOwner?: string }) =>
    Promise.resolve({ committed: false, pushed: false }),
  ),
  runAutoCreatePrStep: mock(() =>
    Promise.resolve({
      created: true,
      syncedExisting: false,
      skipped: false,
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
    }),
  ),
  distillTurnMemoryStep: mock(
    (_params?: {
      chatId?: string;
      sessionRepoDir?: string;
      userId?: string;
      turnId?: string;
    }) => {
      completionSequenceCallOrder.push("distillTurnMemoryStep");
      return Promise.resolve();
    },
  ),
  runTaskCompletionStep: mock(
    (_params?: {
      chatId?: string;
      isError?: boolean;
      finishReason?: string;
    }) => {
      completionSequenceCallOrder.push("runTaskCompletionStep");
      return Promise.resolve();
    },
  ),
};

let testSessionRecord: {
  id: string;
  userId: string;
  autoCommitLocalOverride: boolean | null;
  autoCommitPushOverride: boolean | null;
  autoCreatePrOverride: boolean | null;
  repoOwner: string | null;
  repoName: string | null;
};
let testChatRecord: {
  id: string;
  sessionId: string;
  modelId: string | null;
  turnPolicy: "steer" | "queue";
  backend: "claude-code" | "openfx";
};
/**
 * Backs the `resolveChatResumeToken`/`setChatResumeToken` mock below, one
 * slot per backend id — this chat's resume token is scoped by backend
 * (Section 7 Task 5 follow-up), so a Claude Code token and an OpenFX token
 * must be able to coexist without one clobbering the other across a
 * backend switch.
 */
let testResumeTokens: Record<string, string | null> = {
  "claude-code": null,
  openfx: null,
};
/** What the mocked `runAgentTurn` reports as this turn's resume token. */
let agentResumeTokenToReturn = "claude-session-1";
let testPreferences: {
  defaultModelId: string;
  defaultDiffMode: "unified";
  autoCommitLocal: boolean;
  autoCommitPush: boolean;
  autoCreatePr: boolean;
  alertsEnabled: boolean;
  alertSoundEnabled: boolean;
};

// Track what the agent stream yields
let agentStreamParts: Array<Record<string, unknown>> = [];
let agentAssistantParts: Array<Record<string, unknown>> | undefined;
let agentFinishReason = "stop";
let agentTotalUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
let agentInputMessages: unknown;
let agentTurnCalls: Array<{
  prompt: string;
  maxTurns?: number;
  claudeSessionId?: string;
  /** Which backend the workflow asked this turn to run on (`chat.backend`). */
  chatBackend?: string;
  /** The `AgentCallOptions` the step handed to `runAgentTurn` for this turn. */
  options?: { memorySection?: string };
}> = [];
/** Stands in for the user pressing stop, which reaches the CLI as an abort. */
let agentAbortsTurn = false;

// ── Module mocks ───────────────────────────────────────────────────

mock.module("workflow", () => ({
  getWorkflowMetadata: () => ({ workflowRunId: "wrun_test-123" }),
  getWritable: () => {
    const writable = new WritableStream<UIMessageChunk>({
      write(chunk) {
        writtenChunks.push(chunk);
      },
    });
    return writable;
  },
}));

mock.module("workflow/api", () => ({
  getRun: () => ({
    get status() {
      return Promise.resolve(runStatus);
    },
  }),
}));

mock.module("./chat-post-finish", () => spies);

/**
 * Recorded calls to the (mock) backend's `steer()` — the follow-up review of
 * Task 10 requires steering to go through the backend's own contract
 * (`TurnHandle.steer`) rather than aborting the turn, so tests assert against
 * this instead of an aborted `abortSignal`.
 */
let backendSteerCalls: Array<{ text: string }> = [];

mock.module("@/lib/agent/run-step", () => ({
  runAgentTurn: async (params: {
    prompt: string;
    messageId: string;
    maxTurns?: number;
    claudeSessionId?: string;
    chatBackend?: string;
    originalMessages?: Array<Record<string, unknown>>;
    abortSignal?: AbortSignal;
    steerController?: {
      onSteer: (steer: (text: string) => Promise<void>) => void;
    };
    onChunk: (chunk: Record<string, unknown>) => Promise<void>;
    options?: { memorySection?: string };
  }) => {
    agentInputMessages = params.prompt;
    agentTurnCalls.push({
      prompt: params.prompt,
      maxTurns: params.maxTurns,
      claudeSessionId: params.claudeSessionId,
      chatBackend: params.chatBackend,
      options: params.options,
    });

    if (agentAbortsTurn) {
      throw Object.assign(new Error("The user stopped this run"), {
        name: "AbortError",
      });
    }

    // Steer test support: register a `steer` function exactly like
    // run-step.ts registers `handle.steer` (`onSteer((text) =>
    // handle.steer(text))`) — the workflow calls it later, once its monitor
    // has something to steer with. While a message is still buffered and the
    // chat is on the steer policy, this turn holds open until that happens.
    // Mirrors the real `TurnHandle.steer()` contract: the call resolves
    // NORMALLY with `steered`, it never throws/aborts.
    let steeredText: string | undefined;
    const steeredPromise = new Promise<string>((resolve) => {
      params.steerController?.onSteer((text: string) => {
        backendSteerCalls.push({ text });
        resolve(text);
        return Promise.resolve();
      });
    });
    if (
      testChatRecord.turnPolicy === "steer" &&
      pendingSteerEvents.length > 0
    ) {
      steeredText = await steeredPromise;
    }

    const priorAssistantMessage = params.originalMessages?.at(-1);
    const assistantMessage = (
      priorAssistantMessage?.role === "assistant"
        ? structuredClone(priorAssistantMessage)
        : {
            // runAgentTurn stamps params.messageId onto the reconstructed
            // message; mirror that here so persistence keys on a real id.
            id: params.messageId,
            role: "assistant",
            parts: agentAssistantParts ?? [
              { type: "text", text: `Reply to: ${params.prompt}` },
            ],
            metadata: {},
          }
    ) as {
      id: string;
      role: "assistant";
      parts: Array<Record<string, unknown>>;
      metadata?: unknown;
    };

    for (const part of agentStreamParts) {
      await params.onChunk(part as Record<string, unknown>);
    }

    return {
      responseMessage: assistantMessage,
      usage: {
        inputTokens: agentTotalUsage?.inputTokens ?? 0,
        outputTokens: agentTotalUsage?.outputTokens ?? 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        totalCostUsd: undefined,
        models: {},
      },
      finishReason: agentFinishReason,
      claudeSessionId: agentResumeTokenToReturn,
      costUsd: undefined,
      isError: false,
      ...(steeredText !== undefined ? { steered: { text: steeredText } } : {}),
    };
  },
}));

/**
 * Backs the `generateId` mock below with a counter, not a constant: the
 * primary turn calls it once for its assistantId, and steer/queue tests that
 * run a continuation turn call it again for the continuation's own message
 * id (Task 10 follow-up — each turn is a separate persisted message, so it
 * needs a distinct id). Reset per test so existing single-call tests still
 * see "gen-id-1" for their first (and only) id.
 */
let generateIdCounter = 0;

// Spread over the real module rather than replacing it outright: this file
// mocks `@/lib/agent/run-step` wholesale, so it never needed `readUIMessageStream`
// (real `run-step.ts`'s only other use of "ai") — but `run-step.test.ts`
// exercises the real `run-step.ts`, and `bun test` shares one module registry
// across every file in a single invocation. A from-scratch mock here that
// omitted `readUIMessageStream` used to leak into that file whenever both
// ran in the same process, breaking it with no relation to what it tests.
const realAi = await import("ai");

mock.module("ai", () => ({
  ...realAi,
  convertToModelMessages: async (
    msgs: Array<Record<string, unknown>>,
    options?: { convertDataPart?: (part: Record<string, unknown>) => unknown },
  ) =>
    msgs.map((message) => {
      const parts = Array.isArray(message.parts) ? message.parts : [];
      const content = parts.flatMap((part) => {
        if (typeof part !== "object" || part === null) {
          return [];
        }

        if (part.type === "text" && typeof part.text === "string") {
          return [{ type: "text", text: part.text }];
        }

        if (
          typeof part.type === "string" &&
          part.type.startsWith("data-") &&
          options?.convertDataPart
        ) {
          const convertedPart = options.convertDataPart(
            part as Record<string, unknown>,
          );
          return convertedPart === undefined ? [] : [convertedPart];
        }

        return [];
      });

      return {
        role: message.role,
        content,
      };
    }),
  generateId: () => `gen-id-${++generateIdCounter}`,
  isToolUIPart: (part: { type: string }) =>
    part.type === "tool-invocation" || part.type.startsWith("tool-"),
  pruneMessages: ({ messages }: { messages: Array<Record<string, unknown>> }) =>
    messages.filter((message) => {
      const content = message.content;
      return !Array.isArray(content) || content.length > 0;
    }),
}));

const setChatResumeTokenSpy = mock(
  (_chatId: string, backend: string, resumeToken: string) => {
    testResumeTokens[backend] = resumeToken;
    return Promise.resolve();
  },
);

mock.module("@/lib/db/sessions", () => ({
  getChatById: async () => testChatRecord,
  getSessionById: async () => testSessionRecord,
  // A simplified stand-in for the real (pure) `resolveChatResumeToken`:
  // this fake ignores the `chat` argument (already the case for the
  // predecessor `getChatClaudeSessionId` mock, which ignored its `chatId`)
  // and reads straight from `testResumeTokens`, keyed by backend — which is
  // exactly what the real function reads off the chat row it's given.
  resolveChatResumeToken: (
    _chat: unknown,
    backend: string,
  ): string | undefined => testResumeTokens[backend] ?? undefined,
  setChatResumeToken: setChatResumeTokenSpy,
}));

mock.module("@/lib/db/user-preferences", () => ({
  getUserPreferences: async () => testPreferences,
}));

mock.module("./chat-sandbox-runtime", () => ({
  resolveChatSandboxRuntime: spies.resolveChatSandboxRuntime,
}));

// The turn step now retrieves memory before dispatching. These stand in for
// the real filesystem/DB-touching modules it dynamically imports, so the
// workflow tests stay hermetic — the assertions below control what
// `loadMemorySectionForTurn` returns and check what it was called with.
const SESSION_REPO_DIR = "/workspace/session-1/repo";
let organizationRecord: { id: string } | null = { id: "org-1" };
let memorySectionToReturn: string | undefined;
const loadMemorySectionForTurnSpy = mock(
  (_params: {
    sessionRepoDir?: string;
    userId: string;
    organizationId?: string;
    prompt: string;
  }) => Promise.resolve(memorySectionToReturn),
);

/** Lets a test simulate the repo directory failing to resolve. */
let resolveWorkCwdShouldThrow = false;
mock.module("@/lib/agent/workspace-paths", () => ({
  hostWorkspaceFor: () => "/workspaces/session-1",
  resolveWorkCwd: () => {
    if (resolveWorkCwdShouldThrow) {
      throw new Error("Could not resolve the session repo dir");
    }
    return SESSION_REPO_DIR;
  },
}));
mock.module("@/lib/org/organization", () => ({
  getOrganization: () => Promise.resolve(organizationRecord),
}));
mock.module("@/lib/memory/load-for-turn", () => ({
  loadMemorySectionForTurn: loadMemorySectionForTurnSpy,
}));

/**
 * The turn step also resolves the org roster and plugin skill contributions
 * (Section 3 Task 2 / Section 2 Task 8) the same way it resolves memory
 * above — via a dynamic import this file stands in for. `undefined` here
 * means "let the real default apply" (`resolveChatAgentsSpy` yields `{}`,
 * mirroring an org with nothing configured; `resolveChatSkillsSpy` echoes
 * back whatever workspace skills it was given).
 */
let resolveChatAgentsResult: Record<string, unknown> | undefined;
let resolveChatSkillsResult: unknown[] | undefined;
const resolveChatAgentsSpy = mock((_organizationId: string) =>
  Promise.resolve(resolveChatAgentsResult ?? {}),
);
const resolveChatSkillsSpy = mock((workspaceSkills: unknown[]) =>
  Promise.resolve(resolveChatSkillsResult ?? workspaceSkills),
);
mock.module("@/lib/agent/chat-environment", () => ({
  resolveChatAgents: resolveChatAgentsSpy,
  resolveChatSkills: resolveChatSkillsSpy,
  buildChatEnvironmentDetails: () => "",
}));

/**
 * The design-mode branch (Section 5 Task 2) dynamically imports
 * `@/lib/design/candidates` and `@/lib/design/design-turn` from inside its
 * own `"use step"` function — mocked wholesale here the same way
 * `./chat-post-finish` is above: the fan-out/auto-commit semantics those
 * modules implement are `design-turn.test.ts`'s job, not this file's. What
 * this file checks is that the workflow branches into them correctly and
 * turns their result into a persisted message and a "completed"/"failed"
 * workflow run.
 */
type TestDesignCandidate = {
  index: number;
  branch: string;
  worktreeDir: string;
};
type TestDesignOutcome = TestDesignCandidate & {
  status: "completed" | "failed";
  committed: boolean;
  error?: string;
};

class TestDesignTurnAllFailedError extends Error {
  outcomes: TestDesignOutcome[];
  constructor(outcomes: TestDesignOutcome[]) {
    super("Every design candidate failed");
    this.name = "TestDesignTurnAllFailedError";
    this.outcomes = outcomes;
  }
}

const TEST_FALLBACK_DESIGNER_AGENT = {
  description: "test designer",
  prompt: "You are a test designer agent.",
  model: "sonnet" as const,
};

/** Set by a test to control what `runDesignTurn` resolves/throws. */
let designTurnOutcomesOverride: TestDesignOutcome[] | undefined;
let designTurnShouldFailAll = false;
/** Set by a test to simulate `createCandidates` itself throwing. */
let createCandidatesShouldThrow = false;
/** Set by a test to simulate `runDesignTurn` throwing something other than `DesignTurnAllFailedError`. */
let runDesignTurnShouldThrowUnexpectedError = false;
const createCandidatesSpy = mock(
  (params: {
    chatId: string;
    baseBranch: string;
    count: number;
    sessionWorkspace: string;
  }) => {
    if (createCandidatesShouldThrow) {
      return Promise.reject(new Error("could not create worktree"));
    }
    return Promise.resolve(
      Array.from({ length: params.count }, (_, i): TestDesignCandidate => ({
        index: i + 1,
        branch: `design/${params.chatId}/${i + 1}`,
        worktreeDir: `${params.sessionWorkspace}/designs/${params.chatId}/${i + 1}`,
      })),
    );
  },
);
const removeCandidatesSpy = mock(
  (_params: { sessionWorkspace: string; chatId: string }) =>
    Promise.resolve(),
);
const runDesignTurnSpy = mock(
  async (params: {
    candidates: TestDesignCandidate[];
    prompt: string;
    designerAgent: unknown;
    agentOptions: { sandbox: { environmentDetails?: string } };
    onProgress: (progress: {
      candidate: number;
      status: string;
      error?: string;
    }) => Promise<void>;
  }) => {
    const outcomes: TestDesignOutcome[] =
      designTurnOutcomesOverride ??
      params.candidates.map((candidate) =>
        designTurnShouldFailAll
          ? {
              ...candidate,
              status: "failed" as const,
              committed: false,
              error: "boom",
            }
          : {
              ...candidate,
              status: "completed" as const,
              committed: true,
            },
      );

    for (const candidate of params.candidates) {
      await params.onProgress({
        candidate: candidate.index,
        status: "running",
      });
      await params.onProgress({
        candidate: candidate.index,
        status: "committing",
      });
    }
    for (const outcome of outcomes) {
      await params.onProgress({
        candidate: outcome.index,
        status: outcome.status,
        ...(outcome.error ? { error: outcome.error } : {}),
      });
    }

    if (runDesignTurnShouldThrowUnexpectedError) {
      throw new Error("the backend crashed");
    }

    if (designTurnShouldFailAll) {
      throw new TestDesignTurnAllFailedError(outcomes);
    }

    return { outcomes };
  },
);

mock.module("@/lib/design/candidates", () => ({
  createCandidates: createCandidatesSpy,
  removeCandidates: removeCandidatesSpy,
}));
mock.module("@/lib/design/design-turn", () => ({
  runDesignTurn: runDesignTurnSpy,
  DesignTurnAllFailedError: TestDesignTurnAllFailedError,
  FALLBACK_DESIGNER_AGENT: TEST_FALLBACK_DESIGNER_AGENT,
}));

const { runAgentWorkflow } = await import("./chat");

// ── Helpers ────────────────────────────────────────────────────────

function makeOptions(overrides?: Record<string, unknown>) {
  return {
    messages: [
      {
        id: "user-1",
        role: "user" as const,
        parts: [{ type: "text", text: "Hello" }],
      },
    ],
    chatId: "chat-1",
    sessionId: "session-1",
    userId: "user-1",
    requestUrl: "http://localhost/api/chat",
    authSession: {
      user: {
        id: "user-1",
        username: "user",
        email: "user@example.com",
      },
    },
    selectedModelId: "gpt-4",
    modelId: "gpt-4",
    agentOptions: {},
    maxSteps: 1,
    ...overrides,
  } as Parameters<typeof runAgentWorkflow>[0];
}

/**
 * Turn off automatic saving for tests about something else.
 *
 * It is on by default now, and a commit adds a data part and a diff refresh —
 * extra work these tests would otherwise have to account for.
 */
function disableAutoSave() {
  testPreferences.autoCommitLocal = false;
}

// ── Tests ──────────────────────────────────────────────────────────

beforeEach(() => {
  writtenChunks.length = 0;
  runStatus = "running";
  agentStreamParts = [{ type: "text-delta", textDelta: "Hi" }];
  agentAssistantParts = undefined;
  agentFinishReason = "stop";
  agentTotalUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
  agentInputMessages = undefined;
  agentTurnCalls = [];
  backendSteerCalls = [];
  generateIdCounter = 0;
  agentAbortsTurn = false;
  testSessionRecord = {
    id: "session-1",
    userId: "user-1",
    autoCommitLocalOverride: null,
    autoCommitPushOverride: null,
    autoCreatePrOverride: null,
    repoOwner: "acme",
    repoName: "repo",
  };
  testChatRecord = {
    id: "chat-1",
    sessionId: "session-1",
    modelId: null,
    turnPolicy: "steer",
    backend: "claude-code",
  };
  testResumeTokens = { "claude-code": null, openfx: null };
  agentResumeTokenToReturn = "claude-session-1";
  testPreferences = {
    defaultModelId: "anthropic/claude-haiku-4.5",
    defaultDiffMode: "unified",
    autoCommitLocal: true,
    autoCommitPush: false,
    autoCreatePr: false,
    alertsEnabled: true,
    alertSoundEnabled: true,
  };
  pendingSteerEvents = [];
  nextSteerEventId = 1;
  organizationRecord = { id: "org-1" };
  memorySectionToReturn = undefined;
  resolveWorkCwdShouldThrow = false;
  resolveChatAgentsResult = undefined;
  resolveChatSkillsResult = undefined;
  completionSequenceCallOrder = [];
  designTurnOutcomesOverride = undefined;
  designTurnShouldFailAll = false;
  appendSessionEventsSpy.mockClear();
  listUnconsumedSteerEventsSpy.mockClear();
  setChatResumeTokenSpy.mockClear();
  loadMemorySectionForTurnSpy.mockClear();
  resolveChatAgentsSpy.mockClear();
  resolveChatSkillsSpy.mockClear();
  createCandidatesSpy.mockClear();
  runDesignTurnSpy.mockClear();
  Object.values(spies).forEach((s) => s.mockClear());
});

describe("runAgentWorkflow", () => {
  test("throws when no messages provided", async () => {
    try {
      await runAgentWorkflow(makeOptions({ messages: [] }));
      expect(true).toBe(false);
    } catch (error) {
      expect((error as Error).message).toContain("at least one message");
    }
  });

  test("exits before side effects when another workflow owns the stream slot", async () => {
    spies.claimActiveStream.mockImplementationOnce(() =>
      Promise.resolve("conflict"),
    );

    await runAgentWorkflow(makeOptions());

    expect(writtenChunks).toEqual([]);
    expect(agentInputMessages).toBeUndefined();
    expect(spies.persistAssistantMessage).not.toHaveBeenCalled();
    expect(spies.clearActiveStream).not.toHaveBeenCalled();
    expect(spies.recordWorkflowUsage).not.toHaveBeenCalled();
  });

  test("continues when claiming the stream errors", async () => {
    disableAutoSave();
    spies.claimActiveStream.mockImplementationOnce(
      async (
        _chatId?: unknown,
        _workflowRunId?: unknown,
        writable?: WritableStream<UIMessageChunk>,
        messageId?: string,
      ) => {
        if (writable && messageId) {
          const writer = writable.getWriter();
          try {
            await writer.write({ type: "start", messageId });
          } finally {
            writer.releaseLock();
          }
        }
        return "error";
      },
    );

    await runAgentWorkflow(makeOptions());

    const types = writtenChunks.map((chunk) => chunk.type);
    expect(types[0]).toBe("start");
    expect(types[types.length - 1]).toBe("finish");
    expect(spies.persistAssistantMessage).toHaveBeenCalledTimes(1);
  });

  test("sends start and finish chunks to writable", async () => {
    await runAgentWorkflow(makeOptions());

    const types = writtenChunks.map((c) => c.type);
    expect(types[0]).toBe("start");
    expect(types[types.length - 1]).toBe("finish");
  });

  test("threads a retrieved memory section into the turn's options", async () => {
    memorySectionToReturn = "## Memory\n\nThe user prefers pnpm.";

    await runAgentWorkflow(makeOptions());

    expect(loadMemorySectionForTurnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionRepoDir: SESSION_REPO_DIR,
        userId: "user-1",
        organizationId: "org-1",
        prompt: "Hello",
      }),
    );
    expect(agentTurnCalls[0]?.options?.memorySection).toBe(
      "## Memory\n\nThe user prefers pnpm.",
    );
  });

  test("omits memorySection from the turn's options when retrieval finds nothing", async () => {
    memorySectionToReturn = undefined;

    await runAgentWorkflow(makeOptions());

    expect(agentTurnCalls[0]?.options?.memorySection).toBeUndefined();
  });

  test("proceeds without memory when retrieval throws", async () => {
    loadMemorySectionForTurnSpy.mockImplementationOnce(() => {
      throw new Error("memory backend unavailable");
    });

    await runAgentWorkflow(makeOptions());

    expect(agentTurnCalls[0]?.options?.memorySection).toBeUndefined();
    const types = writtenChunks.map((c) => c.type);
    expect(types[types.length - 1]).toBe("finish");
  });

  test("still loads user/org memory when the session repo dir fails to resolve", async () => {
    // Only project-scope memory needs the repo dir; losing it shouldn't also
    // drop the user's and organisation's memory for the turn.
    resolveWorkCwdShouldThrow = true;

    await runAgentWorkflow(makeOptions());

    expect(loadMemorySectionForTurnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        organizationId: "org-1",
        prompt: "Hello",
      }),
    );
    const call = loadMemorySectionForTurnSpy.mock.calls.at(-1)?.[0] as {
      sessionRepoDir?: string;
    };
    expect(call.sessionRepoDir).toBeUndefined();
  });

  test("still resolves plugin/roster agents when there is no organisation", async () => {
    // `resolveChatAgents` treats the organisation id as optional (plugin
    // agents don't need one); this turn step must call it either way rather
    // than skipping agent resolution entirely when `getOrganization()` comes
    // back empty.
    organizationRecord = null;

    await runAgentWorkflow(makeOptions());

    expect(resolveChatAgentsSpy).toHaveBeenCalledWith(undefined);
  });

  test("gates task completion after auto-PR and before memory distillation", async () => {
    await runAgentWorkflow(makeOptions());

    expect(spies.runTaskCompletionStep).toHaveBeenCalledWith({
      chatId: "chat-1",
      isError: false,
      finishReason: "stop",
    });
    // The reviewer gate decides the task's fate before distillation learns
    // from the turn (Section 3 Task 6) — not after, and not interleaved.
    expect(completionSequenceCallOrder).toEqual([
      "runTaskCompletionStep",
      "distillTurnMemoryStep",
    ]);
  });

  test("marks task completion as an error when the turn's finish reason is error", async () => {
    agentFinishReason = "error";

    await runAgentWorkflow(makeOptions());

    expect(spies.runTaskCompletionStep).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-1", isError: true }),
    );
  });

  test("runs post-turn memory distillation with the session repo dir and the recorder's turnId once the turn finishes", async () => {
    await runAgentWorkflow(makeOptions());

    // The turnId distillation is called with must be the same one the
    // recorder logged for this turn, not an independently-generated value.
    const turnStartEvent = appendSessionEventsSpy.mock.calls
      .flatMap(([, events]) => events as Array<Record<string, unknown>>)
      .find((event) => event.type === "turn/start");
    expect(typeof turnStartEvent?.turnId).toBe("string");

    expect(spies.distillTurnMemoryStep).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "chat-1",
        sessionRepoDir: SESSION_REPO_DIR,
        userId: "user-1",
        turnId: turnStartEvent?.turnId,
      }),
    );
  });

  test("distills every turn once each, not just the last, when a buffered message runs as a continuation", async () => {
    disableAutoSave();
    testChatRecord.turnPolicy = "queue";
    bufferSteerMessage("buffered-2", "Follow-up instruction");

    await runAgentWorkflow(makeOptions());

    const turnStartTurnIds = appendSessionEventsSpy.mock.calls
      .flatMap(([, events]) => events as Array<Record<string, unknown>>)
      .filter((event) => event.type === "turn/start")
      .map((event) => event.turnId as string | undefined);
    // Two turns ran (primary + one continuation), each with its own turnId.
    expect(turnStartTurnIds).toHaveLength(2);
    expect(new Set(turnStartTurnIds).size).toBe(2);

    expect(spies.distillTurnMemoryStep).toHaveBeenCalledTimes(2);
    const distilledTurnIds = spies.distillTurnMemoryStep.mock.calls.map(
      ([params]) => (params as { turnId?: string }).turnId,
    );
    expect(distilledTurnIds).toEqual(turnStartTurnIds);
  });

  test("does not stream transient workspace setup status from runtime prep", async () => {
    spies.resolveChatSandboxRuntime.mockImplementationOnce(async () => {
      return createResolvedChatSandboxRuntime({
        didSetupWorkspace: true,
      });
    });

    await runAgentWorkflow(makeOptions());

    expect(writtenChunks[0]).toEqual({ type: "start", messageId: "gen-id-1" });
    expect(
      writtenChunks.some((chunk) => chunk.type === "data-workspace-status"),
    ).toBe(false);
  });

  test("streams a user-visible message when workspace setup fails", async () => {
    spies.resolveChatSandboxRuntime.mockImplementationOnce(async () => {
      throw new ProvisioningError(
        "github-not-connected",
        "Connect GitHub to access repositories",
      );
    });

    await expect(runAgentWorkflow(makeOptions())).rejects.toThrow(
      "Connect GitHub to access repositories",
    );

    expect(writtenChunks).toEqual(
      expect.arrayContaining([
        { type: "start", messageId: "gen-id-1" },
        { type: "text-start", id: "setup-error" },
        {
          type: "text-delta",
          id: "setup-error",
          delta: setupFailureMessage("github-not-connected"),
        },
        { type: "text-end", id: "setup-error" },
      ]),
    );
    expect(spies.persistAssistantMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({
        id: "gen-id-1",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: setupFailureMessage("github-not-connected"),
          },
        ],
      }),
    );
  });

  test("streams an archived-session setup message when runtime rejects", async () => {
    spies.resolveChatSandboxRuntime.mockImplementationOnce(async () => {
      throw new ProvisioningError("archived", "Session is archived");
    });

    await expect(runAgentWorkflow(makeOptions())).rejects.toThrow(
      "Session is archived",
    );

    expect(writtenChunks).toEqual(
      expect.arrayContaining([
        {
          type: "text-delta",
          id: "setup-error",
          delta: setupFailureMessage("archived"),
        },
      ]),
    );
  });

  /**
   * The shape production actually produces.
   *
   * The two tests above throw a `ProvisioningError` directly, which the durable
   * workflow never does: a provisioning failure is flattened to `error.message`,
   * stored, and rethrown in a *later* run as a plain `Error`. Every one of these
   * used to reach the user as "Workspace setup failed. Try again in a moment."
   */
  test.each([
    ["spawn docker ENOENT", "docker-missing"],
    [
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      "docker-not-running",
    ],
    [
      'Sandbox image "paco-sandbox:latest" is not built. Run: docker build -t paco-sandbox:latest packages/sandbox/docker',
      "image-missing",
    ],
    [
      "Failed to clone https://github.com/acme/app: remote: Repository not found.\nfatal: repository 'https://github.com/acme/app.git/' not found",
      "repo-not-found",
    ],
    [
      "Failed to clone https://github.com/acme/app: fatal: write error: No space left on device",
      "disk-full",
    ],
  ] as const)(
    "explains a setup failure that reached it as plain text: %s",
    async (persistedMessage, expectedReason) => {
      spies.resolveChatSandboxRuntime.mockImplementationOnce(async () => {
        throw new Error(persistedMessage);
      });

      await expect(runAgentWorkflow(makeOptions())).rejects.toThrow();

      const expected = setupFailureMessage(expectedReason);
      expect(expected).not.toBe(setupFailureMessage("unknown"));
      expect(writtenChunks).toEqual(
        expect.arrayContaining([
          { type: "text-delta", id: "setup-error", delta: expected },
        ]),
      );
      // The raw tool output must never be what the user reads.
      expect(
        writtenChunks.some(
          (chunk) =>
            chunk.type === "text-delta" && chunk.delta === persistedMessage,
        ),
      ).toBe(false);
    },
  );

  test("persists assistant message after run", async () => {
    disableAutoSave();

    await runAgentWorkflow(makeOptions());

    expect(spies.persistAssistantMessage).toHaveBeenCalledTimes(1);
    const paCalls = spies.persistAssistantMessage.mock.calls as unknown[][];
    expect(paCalls[0][0]).toBe("chat-1");
  });

  test("persists incoming messages during workflow startup", async () => {
    await runAgentWorkflow(makeOptions());

    expect(spies.persistUserMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({ id: "user-1", role: "user" }),
    );
    expect(spies.persistAssistantMessageWithToolResults).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({ id: "user-1", role: "user" }),
    );
  });

  test("records usage after run", async () => {
    await runAgentWorkflow(makeOptions());

    expect(spies.recordWorkflowUsage).toHaveBeenCalledTimes(1);
    const rwCalls = spies.recordWorkflowUsage.mock.calls as unknown[][];
    expect(rwCalls[0][0]).toBe("user-1");
    expect(rwCalls[0][1]).toBe("gpt-4");
  });

  test("persists model metadata even without a finish-step chunk", async () => {
    await runAgentWorkflow(
      makeOptions({
        selectedModelId: "variant:builtin:gpt-5.4-xhigh",
        modelId: "openai/gpt-5.4",
      }),
    );

    const persistCalls = spies.persistAssistantMessage.mock
      .calls as unknown[][];
    const persistedMessage = persistCalls.at(-1)?.[1] as {
      metadata?: {
        selectedModelId?: string;
        modelId?: string;
      };
    };

    expect(persistedMessage.metadata).toMatchObject({
      selectedModelId: "variant:builtin:gpt-5.4-xhigh",
      modelId: "openai/gpt-5.4",
    });
  });

  test("streams model metadata in finish-step chunks", async () => {
    agentStreamParts = [
      {
        type: "finish-step",
        finishReason: "stop",
        rawFinishReason: "provider_stop",
        usage: agentTotalUsage,
      },
    ];

    await runAgentWorkflow(
      makeOptions({
        selectedModelId: "variant:builtin:gpt-5.4-xhigh",
        modelId: "openai/gpt-5.4",
      }),
    );

    const metadataChunks = writtenChunks.filter(
      (
        chunk,
      ): chunk is UIMessageChunk & {
        type: "message-metadata";
        messageMetadata: {
          selectedModelId?: string;
          modelId?: string;
        };
      } => chunk.type === "message-metadata",
    );

    expect(metadataChunks.at(-1)?.messageMetadata).toMatchObject({
      selectedModelId: "variant:builtin:gpt-5.4-xhigh",
      modelId: "openai/gpt-5.4",
    });

    const persistCalls = spies.persistAssistantMessage.mock
      .calls as unknown[][];
    const persistedMessage = persistCalls.at(-1)?.[1] as {
      metadata?: {
        selectedModelId?: string;
        modelId?: string;
      };
    };

    expect(persistedMessage.metadata).toMatchObject({
      selectedModelId: "variant:builtin:gpt-5.4-xhigh",
      modelId: "openai/gpt-5.4",
    });
  });

  test("overwrites model metadata when resuming an assistant message", async () => {
    agentStreamParts = [
      {
        type: "finish-step",
        finishReason: "stop",
        rawFinishReason: "provider_stop",
        usage: agentTotalUsage,
      },
    ];

    await runAgentWorkflow(
      makeOptions({
        messages: [
          {
            id: "assistant-1",
            role: "assistant" as const,
            parts: [{ type: "text", text: "Need your approval" }],
            metadata: {
              selectedModelId: "variant:builtin:gpt-5.4-xhigh",
              modelId: "openai/gpt-5.4",
            },
          },
        ],
        selectedModelId: "anthropic/claude-opus-4.6",
        modelId: "anthropic/claude-opus-4.6",
      }),
    );

    const persistCalls = spies.persistAssistantMessage.mock
      .calls as unknown[][];
    const persistedMessage = persistCalls.at(-1)?.[1] as {
      metadata?: {
        selectedModelId?: string;
        modelId?: string;
      };
    };

    expect(persistedMessage.metadata).toMatchObject({
      selectedModelId: "anthropic/claude-opus-4.6",
      modelId: "anthropic/claude-opus-4.6",
    });
  });

  test("runs exactly one agent turn even when the turn used tools", async () => {
    // Regression: the workflow used to loop while the finish reason was
    // "tool-calls", which is how the AI SDK signalled "execute the tool and
    // call me back". Claude Code executes tools itself, so there was nothing
    // left to send — each extra iteration handed the model an empty prompt, it
    // replied "your message came through empty", and the run span until the
    // step cap.
    agentFinishReason = "tool-calls";

    await runAgentWorkflow(makeOptions({ maxSteps: 500 }));

    expect(agentTurnCalls).toHaveLength(1);
    expect(agentTurnCalls[0].prompt).toBe("Hello");
  });

  test("never sends an empty prompt", async () => {
    agentFinishReason = "tool-calls";

    await runAgentWorkflow(makeOptions({ maxSteps: 500 }));

    for (const call of agentTurnCalls) {
      expect(call.prompt.trim()).not.toBe("");
    }
  });

  test("takes the prompt from the newest user message, not the newest message", async () => {
    // Resuming a stopped run puts a partial assistant message last. Reading the
    // prompt from only that message yielded "".
    await runAgentWorkflow(
      makeOptions({
        messages: [
          {
            id: "user-1",
            role: "user" as const,
            parts: [{ type: "text", text: "Add a test" }],
          },
          {
            id: "assistant-1",
            role: "assistant" as const,
            parts: [{ type: "text", text: "partial…" }],
            metadata: {},
          },
        ],
      }),
    );

    expect(agentTurnCalls[0].prompt).toBe("Add a test");
  });

  test("passes maxSteps to the CLI as its turn cap", async () => {
    await runAgentWorkflow(makeOptions({ maxSteps: 42 }));

    expect(agentTurnCalls[0].maxTurns).toBe(42);
  });

  test("marks workflow run as failed when the turn cap is exhausted", async () => {
    // `maxSteps` is handed to the CLI as `--max-turns`; a run that hits it ends
    // with `error_max_turns`, which maps to a "length" finish reason.
    agentFinishReason = "length";

    await runAgentWorkflow(
      makeOptions({
        maxSteps: 2,
      }),
    );

    const rwCalls = spies.recordWorkflowUsage.mock.calls as unknown[][];
    const workflowRun = rwCalls[0][5] as {
      workflowRunId: string;
      status: string;
      totalDurationMs: number;
      stepTimings: Array<{
        stepNumber: number;
        durationMs: number;
        finishReason?: string;
      }>;
    };

    expect(workflowRun.workflowRunId).toBe("wrun_test-123");
    expect(workflowRun.status).toBe("failed");
    expect(workflowRun.totalDurationMs).toBeGreaterThanOrEqual(0);
    // Claude Code runs the whole agentic loop in-process, so the workflow makes
    // exactly one step per user turn regardless of how many tools were called.
    expect(workflowRun.stepTimings).toEqual([
      expect.objectContaining({
        stepNumber: 1,
        durationMs: expect.any(Number),
        finishReason: "length",
      }),
    ]);
  });

  test("omits cost metadata when provider does not report gateway cost", async () => {
    agentStreamParts = [
      {
        type: "finish-step",
        finishReason: "stop",
        rawFinishReason: "provider_stop",
        usage: agentTotalUsage,
      },
    ];

    await runAgentWorkflow(makeOptions());

    const persistCalls = spies.persistAssistantMessage.mock
      .calls as unknown[][];
    const persistedMessage = persistCalls.at(-1)?.[1] as {
      metadata?: {
        lastStepCost?: number;
        totalMessageCost?: number;
      };
    };

    expect(persistedMessage.metadata?.lastStepCost).toBeUndefined();
    expect(persistedMessage.metadata?.totalMessageCost).toBeUndefined();
  });

  test("refreshes lifecycle activity before clearing the active stream", async () => {
    const callOrder: string[] = [];
    spies.refreshLifecycleActivity.mockImplementationOnce(async () => {
      callOrder.push("refresh-lifecycle");
    });
    spies.clearActiveStream.mockImplementationOnce(async () => {
      callOrder.push("clear-stream");
    });

    await runAgentWorkflow(makeOptions());

    expect(spies.refreshLifecycleActivity).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["refresh-lifecycle", "clear-stream"]);
  });

  test("persists sandbox state when sandbox is present", async () => {
    await runAgentWorkflow(makeOptions());

    expect(spies.persistSandboxState).toHaveBeenCalledTimes(1);
  });

  test("clears active stream in finally block", async () => {
    await runAgentWorkflow(makeOptions());

    expect(spies.clearActiveStream).toHaveBeenCalledWith(
      "chat-1",
      "wrun_test-123",
    );
  });

  test("skips diff cache refresh when no file-changing tools ran", async () => {
    disableAutoSave();

    await runAgentWorkflow(makeOptions());

    expect(spies.refreshDiffCache).not.toHaveBeenCalled();
  });

  test("refreshes diff cache after a write tool runs", async () => {
    agentStreamParts = [];
    const writeToolPart = {
      type: "tool-write",
      toolCallId: "write-1",
      state: "output-available",
      input: { filePath: "app/page.tsx" },
      output: { success: true },
    };
    agentAssistantParts = [writeToolPart];

    await runAgentWorkflow(makeOptions());

    expect(spies.refreshDiffCache).toHaveBeenCalledTimes(1);
  });

  test("runs auto-commit when enabled and not aborted", async () => {
    await runAgentWorkflow(
      makeOptions({
        autoCommitEnabled: true,
        sessionTitle: "My session",
        repoOwner: "acme",
        repoName: "repo",
      }),
    );

    expect(spies.runAutoCommitStep).toHaveBeenCalledTimes(1);
    expect(spies.runAutoCommitStep).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        repoOwner: "acme",
        repoName: "repo",
      }),
    );
  });

  test("runs auto PR creation when enabled and not aborted", async () => {
    await runAgentWorkflow(
      makeOptions({
        autoCommitEnabled: true,
        autoPushEnabled: true,
        autoCreatePrEnabled: true,
        sessionTitle: "My session",
        repoOwner: "acme",
        repoName: "repo",
      }),
    );

    expect(spies.runAutoCreatePrStep).toHaveBeenCalledTimes(1);
    expect(spies.runAutoCreatePrStep).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        repoOwner: "acme",
        repoName: "repo",
      }),
    );
  });

  test("skips optimistic commit streaming when preflight finds no changes", async () => {
    spies.hasAutoCommitChangesStep.mockImplementationOnce(() =>
      Promise.resolve(false),
    );

    await runAgentWorkflow(
      makeOptions({
        autoCommitEnabled: true,
        autoPushEnabled: true,
        autoCreatePrEnabled: true,
        repoOwner: "acme",
        repoName: "repo",
      }),
    );

    expect(spies.runAutoCommitStep).not.toHaveBeenCalled();
    expect(spies.runAutoCreatePrStep).toHaveBeenCalledTimes(1);
    expect(
      writtenChunks.filter((chunk) => chunk.type === "data-commit"),
    ).toEqual([]);
  });

  test("streams and persists resolved git data parts", async () => {
    spies.runAutoCommitStep.mockImplementationOnce(() =>
      Promise.resolve({
        committed: true,
        pushed: true,
        commitMessage: "feat: add auto git status",
        commitSha: "abc123",
      }),
    );
    spies.runAutoCreatePrStep.mockImplementationOnce(() =>
      Promise.resolve({
        created: true,
        syncedExisting: false,
        skipped: false,
        prNumber: 101,
        prUrl: "https://github.com/acme/repo/pull/101",
      }),
    );

    await runAgentWorkflow(
      makeOptions({
        autoCommitEnabled: true,
        autoPushEnabled: true,
        autoCreatePrEnabled: true,
        repoOwner: "acme",
        repoName: "repo",
      }),
    );

    expect(
      writtenChunks.filter((chunk) => chunk.type === "data-commit"),
    ).toEqual([
      {
        type: "data-commit",
        id: "gen-id-1:commit",
        data: { status: "pending" },
      },
      {
        type: "data-commit",
        id: "gen-id-1:commit",
        data: {
          status: "success",
          committed: true,
          pushed: true,
          commitMessage: "feat: add auto git status",
          commitSha: "abc123",
          url: "https://github.com/acme/repo/commit/abc123",
        },
      },
    ]);
    expect(writtenChunks.filter((chunk) => chunk.type === "data-pr")).toEqual([
      {
        type: "data-pr",
        id: "gen-id-1:pr",
        data: { status: "pending" },
      },
      {
        type: "data-pr",
        id: "gen-id-1:pr",
        data: {
          status: "success",
          created: true,
          syncedExisting: false,
          prNumber: 101,
          url: "https://github.com/acme/repo/pull/101",
        },
      },
    ]);

    const persistCalls = spies.persistAssistantMessage.mock
      .calls as unknown[][];
    const persistedMessage = persistCalls.at(-1)?.[1] as {
      parts: Array<Record<string, unknown>>;
    };

    expect(persistedMessage.parts).toEqual(
      expect.arrayContaining([
        {
          type: "data-commit",
          id: "gen-id-1:commit",
          data: {
            status: "success",
            committed: true,
            pushed: true,
            commitMessage: "feat: add auto git status",
            commitSha: "abc123",
            url: "https://github.com/acme/repo/commit/abc123",
          },
        },
        {
          type: "data-pr",
          id: "gen-id-1:pr",
          data: {
            status: "success",
            created: true,
            syncedExisting: false,
            prNumber: 101,
            url: "https://github.com/acme/repo/pull/101",
          },
        },
      ]),
    );
  });

  test("skips auto PR creation when auto-commit does not push the latest commit", async () => {
    spies.runAutoCommitStep.mockImplementationOnce(() =>
      Promise.resolve({
        committed: true,
        pushed: false,
        error: "Commit succeeded but push failed",
      }),
    );

    await runAgentWorkflow(
      makeOptions({
        autoCommitEnabled: true,
        autoPushEnabled: true,
        autoCreatePrEnabled: true,
        repoOwner: "acme",
        repoName: "repo",
      }),
    );

    expect(spies.runAutoCommitStep).toHaveBeenCalledTimes(1);
    expect(spies.runAutoCreatePrStep).not.toHaveBeenCalled();
  });

  test("skips post-finish automation when the agent pauses for tool input", async () => {
    agentFinishReason = "tool-calls";
    agentStreamParts = [
      {
        type: "finish-step",
        finishReason: "tool-calls",
        rawFinishReason: "provider_tool_use",
        usage: agentTotalUsage,
      },
    ];

    await runAgentWorkflow(
      makeOptions({
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            parts: [
              {
                type: "tool-invocation",
                state: "approval-requested",
              },
            ],
            metadata: {},
          },
        ],
        autoCommitEnabled: true,
        autoPushEnabled: true,
        autoCreatePrEnabled: true,
        repoOwner: "acme",
        repoName: "repo",
      }),
    );

    expect(spies.runAutoCommitStep).not.toHaveBeenCalled();
    expect(spies.runAutoCreatePrStep).not.toHaveBeenCalled();
  });

  test("skips auto PR creation when not enabled", async () => {
    await runAgentWorkflow(
      makeOptions({
        autoCommitEnabled: true,
        autoCreatePrEnabled: false,
        repoOwner: "acme",
        repoName: "repo",
      }),
    );

    expect(spies.runAutoCreatePrStep).not.toHaveBeenCalled();
  });

  test("skips auto-commit when not enabled", async () => {
    await runAgentWorkflow(
      makeOptions({
        autoCommitEnabled: false,
      }),
    );

    expect(spies.runAutoCommitStep).not.toHaveBeenCalled();
  });

  test("still commits locally when the session has no repository", async () => {
    // A local commit needs a worktree, not a remote. Requiring a repo here is
    // what left work in a GitHub-less session unsaved.
    spies.resolveChatSandboxRuntime.mockImplementationOnce(() =>
      Promise.resolve(
        createResolvedChatSandboxRuntime({
          repoOwner: undefined,
          repoName: undefined,
        }),
      ),
    );
    testSessionRecord.repoOwner = null;
    testSessionRecord.repoName = null;
    testPreferences.autoCommitPush = true;

    await runAgentWorkflow(makeOptions());

    expect(spies.runAutoCommitStep).toHaveBeenCalledTimes(1);
    const call = spies.runAutoCommitStep.mock.calls.at(-1)?.[0];
    // Push was asked for, but there is nowhere to push to.
    expect(call?.push).toBe(false);
    expect(call?.repoOwner).toBeUndefined();
  });
});

/**
 * Saving locally, publishing to GitHub, and asking a person to review are three
 * different amounts of exposure, so each is resolved from its own preference.
 * These read the resolution the workflow does for itself — no `autoCommitEnabled`
 * override in the options — because that is the path a real request takes.
 */
describe("auto-save levels", () => {
  const pushFlagOfLastCommit = () =>
    spies.runAutoCommitStep.mock.calls.at(-1)?.[0]?.push;

  test("commits locally and pushes nothing, out of the box", async () => {
    await runAgentWorkflow(makeOptions());

    expect(spies.runAutoCommitStep).toHaveBeenCalledTimes(1);
    expect(pushFlagOfLastCommit()).toBe(false);
    expect(spies.runAutoCreatePrStep).not.toHaveBeenCalled();
  });

  test("pushes as well once backing up to GitHub is on", async () => {
    testPreferences.autoCommitPush = true;

    await runAgentWorkflow(makeOptions());

    expect(pushFlagOfLastCommit()).toBe(true);
    expect(spies.runAutoCreatePrStep).not.toHaveBeenCalled();
  });

  test("opens a pull request once all three are on", async () => {
    testPreferences.autoCommitPush = true;
    testPreferences.autoCreatePr = true;
    spies.runAutoCommitStep.mockImplementationOnce(() =>
      Promise.resolve({ committed: true, pushed: true }),
    );

    await runAgentWorkflow(makeOptions());

    expect(pushFlagOfLastCommit()).toBe(true);
    expect(spies.runAutoCreatePrStep).toHaveBeenCalledTimes(1);
  });

  test("saves nothing when every level is off", async () => {
    testPreferences.autoCommitLocal = false;

    await runAgentWorkflow(makeOptions());

    expect(spies.runAutoCommitStep).not.toHaveBeenCalled();
    expect(spies.runAutoCreatePrStep).not.toHaveBeenCalled();
  });

  test("still commits when local saving is off but pushing is on", async () => {
    // Nothing can be pushed that was not committed first.
    testPreferences.autoCommitLocal = false;
    testPreferences.autoCommitPush = true;

    await runAgentWorkflow(makeOptions());

    expect(spies.runAutoCommitStep).toHaveBeenCalledTimes(1);
    expect(pushFlagOfLastCommit()).toBe(true);
  });

  test("does not open a pull request while pushing is off", async () => {
    testPreferences.autoCreatePr = true;

    await runAgentWorkflow(makeOptions());

    expect(pushFlagOfLastCommit()).toBe(false);
    expect(spies.runAutoCreatePrStep).not.toHaveBeenCalled();
  });

  test("lets a session override the user's default", async () => {
    testSessionRecord.autoCommitLocalOverride = false;

    await runAgentWorkflow(makeOptions());

    expect(spies.runAutoCommitStep).not.toHaveBeenCalled();
  });

  test("does not save a turn the user stopped", async () => {
    // A stopped turn is a half-written state; committing it would file it in
    // the history as finished work.
    agentAbortsTurn = true;

    await runAgentWorkflow(makeOptions());

    // The turn ran and was cut short — not skipped before it started.
    expect(agentTurnCalls).toHaveLength(1);
    expect(spies.runAutoCommitStep).not.toHaveBeenCalled();
  });

  test("does not save a turn that errored", async () => {
    agentFinishReason = "error";

    await runAgentWorkflow(makeOptions());

    expect(spies.runAutoCommitStep).not.toHaveBeenCalled();
  });

  test("does not commit when the worktree is clean", async () => {
    spies.hasAutoCommitChangesStep.mockImplementationOnce(() =>
      Promise.resolve(false),
    );

    await runAgentWorkflow(makeOptions());

    expect(spies.runAutoCommitStep).not.toHaveBeenCalled();
    expect(
      writtenChunks.filter((chunk) => chunk.type === "data-commit"),
    ).toEqual([]);
  });

  test("still clears stream and sends finish even on step error", async () => {
    // Mock the agent to throw
    mock.module("@/app/config", () => ({
      webAgent: {
        tools: {},
        stream: async () => {
          throw new Error("Agent failed");
        },
      },
    }));

    // Re-import to pick up new mock
    const { runAgentWorkflow: reloadedRun } = await import("./chat");

    try {
      await reloadedRun(makeOptions());
    } catch {
      // Expected to throw
    }

    // The finally block should still fire
    expect(spies.clearActiveStream).toHaveBeenCalled();
  });
  test("streams usage and cost metadata for the turn", async () => {
    agentTotalUsage = { inputTokens: 11, outputTokens: 7, totalTokens: 18 };
    agentFinishReason = "stop";

    await runAgentWorkflow(makeOptions());

    const metadataChunks = writtenChunks.filter(
      (
        chunk,
      ): chunk is {
        type: "message-metadata";
        messageMetadata: {
          lastStepUsage?: { inputTokens?: number; outputTokens?: number };
          lastStepFinishReason?: string;
        };
      } => chunk.type === "message-metadata",
    );

    // Claude Code reports one result per turn, so exactly one metadata chunk
    // is streamed rather than one per model step.
    expect(metadataChunks).toHaveLength(1);
    expect(metadataChunks[0]?.messageMetadata.lastStepUsage?.inputTokens).toBe(
      11,
    );
    expect(metadataChunks[0]?.messageMetadata.lastStepUsage?.outputTokens).toBe(
      7,
    );
    expect(metadataChunks[0]?.messageMetadata.lastStepFinishReason).toBe(
      "stop",
    );
  });
});

/**
 * Task 10: a message buffered mid-turn (Task 9's steer/buffered events)
 * either cancels the active turn (steer) or waits for it (queue), and either
 * way runs as a continuation turn afterward — consumed exactly once, recorded
 * as steer/consumed.
 */
describe("turn steering", () => {
  function consumedEvents() {
    return appendSessionEventsSpy.mock.calls
      .flatMap(([, events]) => events as Array<Record<string, unknown>>)
      .filter((event) => event.type === "steer/consumed");
  }

  test("steer policy: a buffered message steers the backend and runs as a continuation", async () => {
    disableAutoSave();
    testChatRecord.turnPolicy = "steer";
    // No prior claudeSessionId: this is the chat's very first turn, the case
    // where steering-via-abort used to lose the session id entirely (the
    // whole `runAgentTurn` call rejected, so `result.resumeToken` was never
    // read). Steering through the backend's own `steer()` instead resolves
    // normally, so the id it carries back is captured just like any other
    // turn.
    testResumeTokens["claude-code"] = null;
    bufferSteerMessage("buffered-1", "Actually, do this instead");

    await runAgentWorkflow(makeOptions());

    // The workflow's steer monitor called the backend's steer() — not
    // AbortController.abort() — with the buffered text.
    expect(backendSteerCalls).toEqual([{ text: "Actually, do this instead" }]);

    expect(agentTurnCalls).toEqual([
      expect.objectContaining({
        prompt: "Hello",
        claudeSessionId: undefined,
      }),
      expect.objectContaining({
        prompt: "Actually, do this instead",
        // Resumed using the session id the STEERED result carried back, not
        // a fresh session — proving the id survived the steer.
        claudeSessionId: "claude-session-1",
      }),
    ]);
    expect(setChatResumeTokenSpy).toHaveBeenCalledWith(
      "chat-1",
      "claude-code",
      "claude-session-1",
    );
    expect(consumedEvents()).toEqual([
      { type: "steer/consumed", messageId: "buffered-1", mode: "steer" },
    ]);
    expect(pendingSteerEvents).toEqual([]);
  });

  test("queue policy: the primary turn completes untouched, then the buffered message follows", async () => {
    disableAutoSave();
    testChatRecord.turnPolicy = "queue";
    bufferSteerMessage("buffered-2", "Follow-up instruction");

    await runAgentWorkflow(makeOptions());

    expect(agentTurnCalls.map((call) => call.prompt)).toEqual([
      "Hello",
      "Follow-up instruction",
    ]);
    expect(backendSteerCalls).toEqual([]);
    expect(consumedEvents()).toEqual([
      { type: "steer/consumed", messageId: "buffered-2", mode: "queue" },
    ]);
    expect(pendingSteerEvents).toEqual([]);
  });

  test("queue policy: both turns' replies survive as separate persisted messages", async () => {
    // Regression: the primary turn and the continuation used to share one
    // assistant message object, so persisting only at the very end silently
    // dropped the primary turn's reply the moment the continuation replaced
    // it in memory.
    disableAutoSave();
    testChatRecord.turnPolicy = "queue";
    bufferSteerMessage("buffered-2", "Follow-up instruction");

    await runAgentWorkflow(makeOptions());

    const persistedMessages = spies.persistAssistantMessage.mock.calls.map(
      ([, message]) => message as { id: string; parts: unknown[] },
    );
    const persistedIds = new Set(persistedMessages.map((m) => m.id));
    // Two distinct rows, not one repeatedly overwritten.
    expect(persistedIds.size).toBe(2);

    const persistedTexts = persistedMessages.map(
      (m) =>
        (m.parts as Array<{ type: string; text?: string }>).find(
          (part) => part.type === "text",
        )?.text,
    );
    expect(persistedTexts).toContain("Reply to: Hello");
    expect(persistedTexts).toContain("Reply to: Follow-up instruction");
  });

  test("two buffered messages are each consumed exactly once, in order, as separate continuation turns", async () => {
    disableAutoSave();
    testChatRecord.turnPolicy = "steer";
    bufferSteerMessage("buffered-1", "First follow-up");
    bufferSteerMessage("buffered-2", "Second follow-up");

    await runAgentWorkflow(makeOptions());

    expect(agentTurnCalls.map((call) => call.prompt)).toEqual([
      "Hello",
      "First follow-up",
      "Second follow-up",
    ]);
    // Steered twice: once by the primary turn seeing buffered-1, once more by
    // the buffered-1 continuation itself still finding buffered-2 pending.
    expect(backendSteerCalls).toEqual([
      { text: "First follow-up" },
      { text: "Second follow-up" },
    ]);
    expect(consumedEvents()).toEqual([
      { type: "steer/consumed", messageId: "buffered-1", mode: "steer" },
      { type: "steer/consumed", messageId: "buffered-2", mode: "steer" },
    ]);
    expect(pendingSteerEvents).toEqual([]);
  });

  test("does not auto-continue a turn the user genuinely stopped", async () => {
    // A user stop is not a steer: nothing buffered caused it, so a message
    // that happens to be pending should not be picked up as a continuation.
    // Uses the queue policy so no steer monitor is armed to race the forced
    // stop — the guard under test is the workflow loop's own condition, not
    // which of two abort sources gets there first.
    disableAutoSave();
    testChatRecord.turnPolicy = "queue";
    agentAbortsTurn = true;
    bufferSteerMessage("buffered-3", "Should not run");

    await runAgentWorkflow(makeOptions());

    expect(agentTurnCalls.map((call) => call.prompt)).toEqual(["Hello"]);
    expect(consumedEvents()).toEqual([]);
    expect(pendingSteerEvents).toEqual([
      { id: 1, messageId: "buffered-3", text: "Should not run" },
    ]);
  });
});

/**
 * Resume tokens are scoped per backend (`chats.resumeTokens`, keyed by
 * backend id) rather than one shared column — the CRITICAL bug this closes:
 * `OpenFxBackend.loadSession({sessionId: <a Claude Code session id>})` (or
 * the reverse, `--resume <an ACP session id>` handed to Claude Code) is what
 * a single shared `claudeSessionId` column produced the moment a chat's
 * backend was switched mid-conversation. See `resolveChatResumeToken`'s doc
 * in `lib/db/sessions.ts`.
 */
describe("resume tokens scoped per backend", () => {
  test("switching backends never resumes with the other backend's token, and switching back resumes the original", async () => {
    disableAutoSave();

    // Turn 1: claude-code, from a fresh chat.
    testChatRecord.backend = "claude-code";
    agentResumeTokenToReturn = "claude-session-1";
    await runAgentWorkflow(makeOptions());

    // Turn 2: switched to openfx. Must NOT attempt to resume with the
    // Claude Code session id from turn 1 — this is the bug: OpenFX would
    // call `session/load` with a session id it never created.
    testChatRecord.backend = "openfx";
    agentResumeTokenToReturn = "openfx-session-1";
    await runAgentWorkflow(makeOptions());

    // Turn 3: switched back to claude-code. Must resume with the ORIGINAL
    // claude-code token from turn 1, not undefined and not openfx's token.
    testChatRecord.backend = "claude-code";
    agentResumeTokenToReturn = "claude-session-1-continued";
    await runAgentWorkflow(makeOptions());

    expect(agentTurnCalls).toEqual([
      expect.objectContaining({
        chatBackend: "claude-code",
        claudeSessionId: undefined,
      }),
      expect.objectContaining({
        chatBackend: "openfx",
        // The critical assertion: no resume token crosses from
        // claude-code's session into openfx's turn. `undefined` here is
        // what tells `resolveBackend`'s `OpenFxBackend` to start a fresh
        // `session/new` rather than `session/load`.
        claudeSessionId: undefined,
      }),
      expect.objectContaining({
        chatBackend: "claude-code",
        // Resumes the ORIGINAL claude-code token from turn 1 — proving the
        // openfx turn in between did not overwrite or clear it.
        claudeSessionId: "claude-session-1",
      }),
    ]);

    // Each turn's result was written back under the backend that actually
    // produced it, never under the other one's key.
    expect(setChatResumeTokenSpy.mock.calls).toEqual([
      ["chat-1", "claude-code", "claude-session-1"],
      ["chat-1", "openfx", "openfx-session-1"],
      ["chat-1", "claude-code", "claude-session-1-continued"],
    ]);
  });
});

describe("design mode", () => {
  test("creates candidates, fans out a design turn, and persists a summary message", async () => {
    await runAgentWorkflow(makeOptions({ mode: "design" }));

    expect(createCandidatesSpy).toHaveBeenCalledTimes(1);
    const createCall = createCandidatesSpy.mock.calls[0][0] as {
      chatId: string;
      baseBranch: string;
      count: number;
      sessionWorkspace: string;
    };
    expect(createCall.chatId).toBe("chat-1");
    // The chat's own branch, not the repository's default branch — a design
    // candidate is created from the chat's worktree, per the plan's
    // branch-naming constraint.
    expect(createCall.baseBranch).toBe("main");
    expect(createCall.count).toBe(3);

    expect(runDesignTurnSpy).toHaveBeenCalledTimes(1);
    const runCall = runDesignTurnSpy.mock.calls[0][0] as {
      prompt: string;
      candidates: TestDesignCandidate[];
      designerAgent: unknown;
    };
    expect(runCall.prompt).toBe("Hello");
    expect(runCall.candidates).toHaveLength(3);
    // No organisation roster override was configured for this test, so the
    // fallback designer persona is what actually frames every candidate.
    expect(runCall.designerAgent).toBe(TEST_FALLBACK_DESIGNER_AGENT);

    // Every candidate's progress reached the client live, in order.
    const progressChunks = writtenChunks.filter(
      (chunk) => (chunk as { type: string }).type === "data-design-progress",
    ) as Array<{ id: string; data: { candidate: number; status: string } }>;
    expect(progressChunks.length).toBeGreaterThan(0);
    const candidate1Statuses = progressChunks
      .filter((chunk) => chunk.data.candidate === 1)
      .map((chunk) => chunk.data.status);
    expect(candidate1Statuses).toEqual(["running", "committing", "completed"]);

    expect(spies.persistAssistantMessage).toHaveBeenCalled();
    const persistCalls = spies.persistAssistantMessage.mock.calls as Array<
      [string, { parts: Array<{ type: string }> }]
    >;
    const lastPersisted = persistCalls.at(-1)?.[1];
    expect(lastPersisted?.parts.some((part) => part.type === "text")).toBe(
      true,
    );
    expect(
      lastPersisted?.parts.filter(
        (part) => part.type === "data-design-progress",
      ),
    ).toHaveLength(3);

    expect(spies.clearActiveStream).toHaveBeenCalled();
    expect(spies.sendFinish).toHaveBeenCalled();

    const rwCalls = spies.recordWorkflowUsage.mock.calls as unknown[][];
    const workflowRun = rwCalls.at(-1)?.[5] as { status: string };
    expect(workflowRun.status).toBe("completed");
  });

  test("honors designCandidateCount", async () => {
    await runAgentWorkflow(
      makeOptions({ mode: "design", designCandidateCount: 2 }),
    );

    const createCall = createCandidatesSpy.mock.calls[0][0] as {
      count: number;
    };
    expect(createCall.count).toBe(2);
  });

  test("does not run the normal turn machinery in design mode", async () => {
    await runAgentWorkflow(makeOptions({ mode: "design" }));

    // The normal turn path (mocked `@/lib/agent/run-step`) never ran; the
    // design turn is a fully separate step (`runDesignTurnStep`), not a call
    // to the same per-chat `runAgentTurn`.
    expect(agentTurnCalls).toHaveLength(0);
    expect(spies.runAutoCommitStep).not.toHaveBeenCalled();
    expect(spies.runTaskCompletionStep).not.toHaveBeenCalled();
    expect(spies.distillTurnMemoryStep).not.toHaveBeenCalled();
  });

  test("marks the workflow run as failed when every candidate fails", async () => {
    designTurnShouldFailAll = true;

    await runAgentWorkflow(makeOptions({ mode: "design" }));

    const rwCalls = spies.recordWorkflowUsage.mock.calls as unknown[][];
    const workflowRun = rwCalls.at(-1)?.[5] as { status: string };
    expect(workflowRun.status).toBe("failed");

    // Still persists what happened — every candidate reported as failed —
    // rather than losing the turn's outcome because it happened to fail.
    const persistCalls = spies.persistAssistantMessage.mock.calls as Array<
      [string, { parts: Array<{ type: string; data?: { status: string } }> }]
    >;
    const lastPersisted = persistCalls.at(-1)?.[1];
    const progressParts = lastPersisted?.parts.filter(
      (part) => part.type === "data-design-progress",
    );
    expect(progressParts).toHaveLength(3);
    expect(progressParts?.every((part) => part.data?.status === "failed")).toBe(
      true,
    );

    expect(spies.clearActiveStream).toHaveBeenCalled();
    expect(spies.sendFinish).toHaveBeenCalled();
  });

  test("one candidate failing still marks the run completed", async () => {
    designTurnOutcomesOverride = [
      {
        index: 1,
        branch: "design/chat-1/1",
        worktreeDir: "/workspaces/session-1/designs/chat-1/1",
        status: "completed",
        committed: true,
      },
      {
        index: 2,
        branch: "design/chat-1/2",
        worktreeDir: "/workspaces/session-1/designs/chat-1/2",
        status: "failed",
        committed: false,
        error: "candidate 2 crashed",
      },
      {
        index: 3,
        branch: "design/chat-1/3",
        worktreeDir: "/workspaces/session-1/designs/chat-1/3",
        status: "completed",
        committed: true,
      },
    ];

    await runAgentWorkflow(makeOptions({ mode: "design" }));

    const rwCalls = spies.recordWorkflowUsage.mock.calls as unknown[][];
    const workflowRun = rwCalls.at(-1)?.[5] as { status: string };
    expect(workflowRun.status).toBe("completed");
  });
});

/**
 * Lint-style guard, per review: `runAgentWorkflow`'s body runs `"use
 * workflow"`, which the Workflow SDK replays in a sandboxed VM with no Node
 * modules. A direct call to a `@/lib/db/*` export from inside that body
 * would crash on every turn in production — invisible here because this
 * suite mocks the DB modules — so this reads the source and checks the
 * workflow body's text never calls one directly; every such call must go
 * through its own `"use step"` wrapper instead (e.g. `readPendingSteerStep`,
 * `consumeSteerStep`).
 */
describe("workflow-sandbox safety", () => {
  test("the workflow body never calls a @/lib/db/* export directly", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("chat.ts", import.meta.url), "utf8");

    const dbImportSymbols = new Set<string>();
    const importRegex =
      /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+"@\/lib\/db\/[^"]+";/g;
    for (const match of source.matchAll(importRegex)) {
      for (const rawName of (match[1] ?? "").split(",")) {
        const name = rawName.replace(/^\s*type\s+/, "").trim();
        if (name) {
          dbImportSymbols.add(name);
        }
      }
    }
    // Sanity: the regex above actually found something to check, so this
    // test would fail loudly (empty violations trivially pass) if chat.ts
    // ever stopped importing from @/lib/db/* altogether.
    expect(dbImportSymbols.size).toBeGreaterThan(0);

    const workflowStart = source.indexOf(
      "export async function runAgentWorkflow",
    );
    const workflowEnd = source.indexOf("\nfunction extractLatestUserText");
    expect(workflowStart).toBeGreaterThan(-1);
    expect(workflowEnd).toBeGreaterThan(workflowStart);
    const workflowBody = source.slice(workflowStart, workflowEnd);

    const violations = [...dbImportSymbols].filter((name) =>
      new RegExp(`[^.\\w]${name}\\(`).test(workflowBody),
    );

    expect(violations).toEqual([]);
  });
});
