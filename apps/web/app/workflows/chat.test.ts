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
  hasCommitsToProposeStep: mock(() => Promise.resolve(true)),
  // Typed loosely on purpose: the tests read `chatId` and `turnId` off the
  // recorded call to check the snapshot is filed against the right turn.
  runTurnSnapshotStep: mock((_params?: { chatId?: string; turnId?: string }) =>
    Promise.resolve(),
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
  backend: "claude-code" | "poolside";
};
/**
 * Backs the `resolveChatResumeToken`/`setChatResumeToken` mock below, one
 * slot per backend id — this chat's resume token is scoped by backend
 * so a Claude Code token and a Poolside token must be able to coexist
 * without one clobbering the other across a backend switch.
 */
let testResumeTokens: Record<string, string | null> = {
  "claude-code": null,
  poolside: null,
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
type TestAgentTurnOptions = {
  memorySection?: string;
  mcpServers?: Record<
    string,
    { command: string; args: string[]; env: Record<string, string> }
  >;
};
let agentTurnCalls: Array<{
  prompt: string;
  maxTurns?: number;
  claudeSessionId?: string;
  /** Which backend the workflow asked this turn to run on (`chat.backend`). */
  chatBackend?: string;
  /** The `AgentCallOptions` the step handed to `runAgentTurn` for this turn. */
  options?: TestAgentTurnOptions;
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
    options?: TestAgentTurnOptions;
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

// `convertToModelMessages`/`pruneMessages` used to be stubbed here too, for
// a `convertMessages` step whose output `runAgentStep` never read. Both the
// step and the stubs are gone: the real exports now stand, so a file sharing
// this registry gets the library's behaviour rather than this file's.
mock.module("ai", () => ({
  ...realAi,
  generateId: () => `gen-id-${++generateIdCounter}`,
  isToolUIPart: (part: { type: string }) =>
    part.type === "tool-invocation" || part.type.startsWith("tool-"),
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
  (_params: { sessionRepoDir?: string; prompt: string }) =>
    Promise.resolve(memorySectionToReturn),
);

/** Lets a test simulate the repo directory failing to resolve. */
let resolveWorkCwdShouldThrow = false;
/**
 * Where `hostWorkspaceFor` says this session's workspace lives.
 *
 * A `let` rather than a constant because the attachment tests below stage
 * real files under it: an attachment too large to inline is written to disk
 * and the prompt names its path, so proving that requires a directory that
 * actually exists.
 */
let hostWorkspaceDir = "/workspaces/session-1";
mock.module("@/lib/agent/workspace-paths", () => ({
  hostWorkspaceFor: () => hostWorkspaceDir,
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
/**
 * Plugin-contributed MCP servers for a turn (`--mcp-config`), resolved the
 * same way roster/skills are above. `undefined` (the default) means "no
 * plugins enabled" — `resolveChatMcpServers` itself returns `undefined` in
 * that case, never an empty object (see its own doc).
 */
let resolveChatMcpServersResult:
  | Record<
      string,
      { command: string; args: string[]; env: Record<string, string> }
    >
  | undefined;
const resolveChatMcpServersSpy = mock(() =>
  Promise.resolve(resolveChatMcpServersResult),
);
mock.module("@/lib/agent/chat-environment", () => ({
  resolveChatAgents: resolveChatAgentsSpy,
  resolveChatMcpServers: resolveChatMcpServersSpy,
  resolveChatSkills: resolveChatSkillsSpy,
  buildChatEnvironmentDetails: () => "",
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

/** Every session event the workflow appended, flattened into append order. */
function loggedEvents(): Array<Record<string, unknown>> {
  return appendSessionEventsSpy.mock.calls.flatMap(
    ([, events]) => events as Array<Record<string, unknown>>,
  );
}

/**
 * A single-user-message option set whose message id is distinguishable from
 * everything else in these tests.
 *
 * `makeOptions`'s default uses `"user-1"` for BOTH the message id and the
 * userId, which is exactly the ambiguity the `user/message.messageId` tests
 * below have to rule out.
 */
function makeOptionsWithUserMessage(overrides?: Record<string, unknown>) {
  return makeOptions({
    messages: [
      {
        id: "user-msg-1",
        role: "user" as const,
        parts: [{ type: "text", text: "Hello" }],
      },
    ],
    ...overrides,
  });
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
  testResumeTokens = { "claude-code": null, poolside: null };
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
  hostWorkspaceDir = "/workspaces/session-1";
  resolveChatAgentsResult = undefined;
  resolveChatSkillsResult = undefined;
  resolveChatMcpServersResult = undefined;
  completionSequenceCallOrder = [];
  appendSessionEventsSpy.mockClear();
  listUnconsumedSteerEventsSpy.mockClear();
  setChatResumeTokenSpy.mockClear();
  loadMemorySectionForTurnSpy.mockClear();
  resolveChatAgentsSpy.mockClear();
  resolveChatSkillsSpy.mockClear();
  resolveChatMcpServersSpy.mockClear();
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
        prompt: "Hello",
      }),
    );
    expect(agentTurnCalls[0]?.options?.memorySection).toBe(
      "## Memory\n\nThe user prefers pnpm.",
    );
  });

  test("logs the memory section and the roster/skills/mcp servers it injected into the turn", async () => {
    // Everything below reaches the model — memory through the system prompt,
    // the rest through the CLI's own flags — and none of it is
    // reconstructable from `turn/start`, so a replay that doesn't see it
    // rebuilds a turn the model never had.
    memorySectionToReturn = "## Memory\n\nThe user prefers pnpm.";
    resolveChatAgentsResult = {
      designer: { description: "d", prompt: "p" },
      reviewer: { description: "r", prompt: "p" },
    };
    resolveChatSkillsResult = [
      {
        name: "deploy",
        description: "Ship it",
        path: "/skills/deploy",
        filename: "SKILL.md",
        options: {},
      },
    ];
    resolveChatMcpServersResult = {
      "plugin-a": { command: "node", args: ["bridge.mjs"], env: {} },
    };

    await runAgentWorkflow(makeOptions());

    const events = loggedEvents();
    const turnStart = events.find((event) => event.type === "turn/start");
    const context = events.find((event) => event.type === "turn/context");
    expect(context).toBeDefined();
    expect(context?.turnId).toBe(turnStart?.turnId);
    expect(context?.memorySection).toBe("## Memory\n\nThe user prefers pnpm.");
    // Names only: a skill's body is already on disk, and the question the log
    // has to answer is which ones were attached.
    expect(context?.agents).toEqual(["designer", "reviewer"]);
    expect(context?.skills).toEqual(["deploy"]);
    expect(context?.mcpServers).toEqual(["plugin-a"]);
  });

  test("logs no turn/context when nothing extra was injected into the turn", async () => {
    memorySectionToReturn = undefined;

    await runAgentWorkflow(makeOptions());

    expect(loggedEvents().some((event) => event.type === "turn/context")).toBe(
      false,
    );
  });

  test("logs the user's row id on turn/start and user/message, not the assistant's", async () => {
    await runAgentWorkflow(makeOptionsWithUserMessage());

    const events = loggedEvents();
    const turnStart = events.find((event) => event.type === "turn/start");
    const userMessage = events.find((event) => event.type === "user/message");

    expect(userMessage).toMatchObject({
      messageId: "user-msg-1",
      text: "Hello",
    });
    // "gen-id-1" is the assistant row this turn writes. Naming it here points
    // anything correlating the logged user message back to `chatMessages` at
    // the wrong row.
    expect(userMessage?.messageId).not.toBe("gen-id-1");
    expect(turnStart?.messageId).toBe("user-msg-1");
  });

  test("a continuation turn logs the buffered user row, not its own assistant row", async () => {
    disableAutoSave();
    testChatRecord.turnPolicy = "queue";
    bufferSteerMessage("buffered-2", "Follow-up instruction");

    await runAgentWorkflow(makeOptionsWithUserMessage());

    const userMessageIds = loggedEvents()
      .filter((event) => event.type === "user/message")
      .map((event) => event.messageId);
    // The continuation's assistant row does not even exist yet when its
    // `turn/start` is logged, which is the second reason the assistant id is
    // the wrong thing to put here.
    expect(userMessageIds).toEqual(["user-msg-1", "buffered-2"]);
  });

  test("omits memorySection from the turn's options when retrieval finds nothing", async () => {
    memorySectionToReturn = undefined;

    await runAgentWorkflow(makeOptions());

    expect(agentTurnCalls[0]?.options?.memorySection).toBeUndefined();
  });

  test("threads plugin-contributed MCP servers into the turn's options", async () => {
    resolveChatMcpServersResult = {
      "plugin-a": { command: "node", args: ["bridge.mjs"], env: {} },
    };

    await runAgentWorkflow(makeOptions());

    expect(agentTurnCalls[0]?.options?.mcpServers).toEqual({
      "plugin-a": { command: "node", args: ["bridge.mjs"], env: {} },
    });
  });

  test("omits mcpServers from the turn's options when no plugins are enabled", async () => {
    resolveChatMcpServersResult = undefined;

    await runAgentWorkflow(makeOptions());

    expect(agentTurnCalls[0]?.options?.mcpServers).toBeUndefined();
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

  test("still loads instance memory when the session repo dir fails to resolve", async () => {
    // Only project-scope memory needs the repo dir; losing it shouldn't also
    // drop the instance's memory for the turn.
    resolveWorkCwdShouldThrow = true;

    await runAgentWorkflow(makeOptions());

    expect(loadMemorySectionForTurnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
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
    expect(rwCalls[0][0]).toBe("gpt-4");
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
    const workflowRun = rwCalls[0][4] as {
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

  test("takes a turn snapshot instead of committing", async () => {
    await runAgentWorkflow(
      makeOptions({
        autoCommitEnabled: true,
        sessionTitle: "My session",
        repoOwner: "acme",
        repoName: "repo",
      }),
    );

    expect(spies.runTurnSnapshotStep).toHaveBeenCalledTimes(1);
    expect(spies.runTurnSnapshotStep).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-1" }),
    );
  });

  test("never streams a commit card, because nothing commits", async () => {
    await runAgentWorkflow(
      makeOptions({
        autoCommitEnabled: true,
        autoPushEnabled: true,
        repoOwner: "acme",
        repoName: "repo",
      }),
    );

    expect(
      writtenChunks.filter((chunk) => chunk.type === "data-commit"),
    ).toEqual([]);
  });

  test("runs auto PR creation when enabled and the branch is ahead", async () => {
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
        repoOwner: "acme",
        repoName: "repo",
      }),
    );
  });

  test("refuses to open an empty pull request, and says why", async () => {
    // The ordinary case now: the turn's work is uncommitted, so there is
    // nothing for a pull request to propose. Silently doing nothing would
    // leave someone who switched auto-PR on waiting for a link.
    spies.hasCommitsToProposeStep.mockImplementationOnce(() =>
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

    expect(spies.runAutoCreatePrStep).not.toHaveBeenCalled();
    const prChunks = writtenChunks.filter(
      (chunk) => chunk.type === "data-pr",
    ) as Array<{ data: { status: string; skipReason?: string } }>;
    expect(prChunks).toHaveLength(1);
    expect(prChunks[0]?.data.status).toBe("skipped");
    expect(prChunks[0]?.data.skipReason).toBe(
      "Nothing committed yet — commit to open a pull request",
    );
    // The card renders this as one truncated line, so a reason that runs long
    // loses its ending — and the ending is the instruction.
    expect(prChunks[0]?.data.skipReason?.length).toBeLessThanOrEqual(60);
  });

  test("streams and persists the resolved pull-request part", async () => {
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

    expect(spies.runTurnSnapshotStep).not.toHaveBeenCalled();
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

  test("snapshots even with a session that has no repository", async () => {
    // A snapshot is local bookkeeping. It needs a worktree, not a remote.
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

    await runAgentWorkflow(makeOptions());

    expect(spies.runTurnSnapshotStep).toHaveBeenCalledTimes(1);
    expect(spies.runAutoCreatePrStep).not.toHaveBeenCalled();
  });
});

/**
 * What survives the end of a turn.
 *
 * Nothing commits any more, so the only two questions left are whether the
 * turn was snapshotted and whether a pull request was opened — and the second
 * now depends on the operator having committed, not on the agent having run.
 */
describe("end-of-turn automation", () => {
  test("snapshots every finished turn, whatever the preferences say", async () => {
    // Snapshots are how undo works. Making them conditional on a save
    // preference would take undo away from anyone who turned saving off.
    testPreferences.autoCommitLocal = false;
    testPreferences.autoCommitPush = false;

    await runAgentWorkflow(makeOptions());

    expect(spies.runTurnSnapshotStep).toHaveBeenCalledTimes(1);
    expect(spies.runAutoCreatePrStep).not.toHaveBeenCalled();
  });

  test("opens a pull request once pushing and PR creation are both on", async () => {
    testPreferences.autoCommitPush = true;
    testPreferences.autoCreatePr = true;

    await runAgentWorkflow(makeOptions());

    expect(spies.runAutoCreatePrStep).toHaveBeenCalledTimes(1);
  });

  test("does not open a pull request while pushing is off", async () => {
    testPreferences.autoCreatePr = true;

    await runAgentWorkflow(makeOptions());

    expect(spies.runAutoCreatePrStep).not.toHaveBeenCalled();
  });

  test("does not snapshot a turn the user stopped", async () => {
    // A stopped turn is a half-written state; filing it as this turn's result
    // would make undo restore something that never finished.
    agentAbortsTurn = true;

    await runAgentWorkflow(makeOptions());

    // The turn ran and was cut short — not skipped before it started.
    expect(agentTurnCalls).toHaveLength(1);
    expect(spies.runTurnSnapshotStep).not.toHaveBeenCalled();
  });

  test("does not snapshot a turn that errored", async () => {
    agentFinishReason = "error";

    await runAgentWorkflow(makeOptions());

    expect(spies.runTurnSnapshotStep).not.toHaveBeenCalled();
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
 * `PoolsideBackend` calling `session/load` with a Claude Code session id
 * (or the reverse, `--resume <an ACP session id>` handed to Claude Code) is
 * what a single shared `claudeSessionId` column produced the moment a
 * chat's backend was switched mid-conversation. See
 * `resolveChatResumeToken`'s doc in `lib/db/sessions.ts`.
 */
describe("resume tokens scoped per backend", () => {
  test("switching backends never resumes with the other backend's token, and switching back resumes the original", async () => {
    disableAutoSave();

    // Turn 1: claude-code, from a fresh chat.
    testChatRecord.backend = "claude-code";
    agentResumeTokenToReturn = "claude-session-1";
    await runAgentWorkflow(makeOptions());

    // Turn 2: switched to poolside. Must NOT attempt to resume with the
    // Claude Code session id from turn 1 — this is the bug: Poolside would
    // call `session/load` with a session id it never created.
    testChatRecord.backend = "poolside";
    agentResumeTokenToReturn = "poolside-session-1";
    await runAgentWorkflow(makeOptions());

    // Turn 3: switched back to claude-code. Must resume with the ORIGINAL
    // claude-code token from turn 1, not undefined and not poolside's.
    testChatRecord.backend = "claude-code";
    agentResumeTokenToReturn = "claude-session-1-continued";
    await runAgentWorkflow(makeOptions());

    expect(agentTurnCalls).toEqual([
      expect.objectContaining({
        chatBackend: "claude-code",
        claudeSessionId: undefined,
      }),
      expect.objectContaining({
        chatBackend: "poolside",
        // The critical assertion: no resume token crosses from
        // claude-code's session into poolside's turn. `undefined` here is
        // what tells `resolveBackend`'s `PoolsideBackend` to start a fresh
        // `session/new` rather than `session/load`.
        claudeSessionId: undefined,
      }),
      expect.objectContaining({
        chatBackend: "claude-code",
        // Resumes the ORIGINAL claude-code token from turn 1 — proving the
        // poolside turn in between did not overwrite or clear it.
        claudeSessionId: "claude-session-1",
      }),
    ]);

    // Each turn's result was written back under the backend that actually
    // produced it, never under the other one's key.
    expect(setChatResumeTokenSpy.mock.calls).toEqual([
      ["chat-1", "claude-code", "claude-session-1"],
      ["chat-1", "poolside", "poolside-session-1"],
      ["chat-1", "claude-code", "claude-session-1-continued"],
    ]);
  });
});

/*
 * Attachments.
 *
 * The composer turns an uploaded file — or a pasted block big enough for
 * `text-attachment-utils.ts` to promote — into a `data-snippet` part, and an
 * image into a `file` part. Both were persisted and rendered in the
 * transcript, and neither reached the model: the prompt was built by
 * filtering the newest user message down to `type === "text"` parts, so the
 * one part carrying the content was dropped on the floor. Every "why is it
 * ignoring my log file?" was this.
 */
describe("attachments", () => {
  test("a data-snippet part's filename and content reach the prompt", async () => {
    await runAgentWorkflow(
      makeOptions({
        messages: [
          {
            id: "user-1",
            role: "user" as const,
            parts: [
              { type: "text", text: "Why is this failing?" },
              {
                type: "data-snippet",
                id: "snippet-1",
                data: {
                  filename: "pasted.log",
                  content: "ERROR boom\n  at thing (thing.ts:4)",
                },
              },
            ],
          },
        ],
      }),
    );

    const prompt = agentTurnCalls[0]?.prompt ?? "";
    expect(prompt).toContain("Why is this failing?");
    expect(prompt).toContain("pasted.log");
    expect(prompt).toContain("ERROR boom");
    expect(prompt).toContain("at thing (thing.ts:4)");
  });

  test("the logged prompt is the prompt that was dispatched", async () => {
    // The spine invariant (`recorder.assertPromptLogged`): what the model saw
    // has to be what a replay of `turn/start` rebuilds. Enriching the prompt
    // with attachment content is only honest if the log moves with it.
    await runAgentWorkflow(
      makeOptions({
        messages: [
          {
            id: "user-1",
            role: "user" as const,
            parts: [
              { type: "text", text: "Look at this" },
              {
                type: "data-snippet",
                id: "snippet-1",
                data: { filename: "notes.txt", content: "the contents" },
              },
            ],
          },
        ],
      }),
    );

    const started = appendSessionEventsSpy.mock.calls
      .flatMap(([, events]) => events)
      .find((event) => event.type === "turn/start") as
      | { prompt: string }
      | undefined;
    expect(started?.prompt).toBe(agentTurnCalls[0]?.prompt);
    expect(started?.prompt).toContain("the contents");
  });

  test("an attachment too large to inline is staged to a file the prompt names", async () => {
    // Attachments are often logs. Inlining a multi-megabyte paste whole is a
    // different failure — a turn that costs a fortune or is rejected outright
    // — so past the budget the content goes to disk and the agent is told
    // where to read it from.
    const { mkdtempSync } = await import("node:fs");
    const { readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    hostWorkspaceDir = mkdtempSync(join(tmpdir(), "paco-attachment-test-"));

    const huge = `${"log line with enough text to matter\n".repeat(20_000)}NEEDLE_AT_THE_END`;

    await runAgentWorkflow(
      makeOptions({
        messages: [
          {
            id: "user-1",
            role: "user" as const,
            parts: [
              { type: "text", text: "Find the error" },
              {
                type: "data-snippet",
                id: "snippet-1",
                data: { filename: "huge.log", content: huge },
              },
            ],
          },
        ],
      }),
    );

    const prompt = agentTurnCalls[0]?.prompt ?? "";
    expect(prompt).toContain("Find the error");
    expect(prompt).toContain("huge.log");
    // Not inlined: the prompt stays small, and the tail of the file is only
    // reachable by reading the path.
    expect(prompt.length).toBeLessThan(huge.length / 10);
    expect(prompt).not.toContain("NEEDLE_AT_THE_END");

    // The path it names is real, and holds the whole attachment.
    const pathMatch = prompt.match(/(\/\S*huge\.log)/);
    expect(pathMatch).not.toBeNull();
    const staged = await readFile(pathMatch?.[1] ?? "", "utf8");
    expect(staged).toBe(huge);
  });

  test("an image reaches the agent as a path it can read", async () => {
    // `file` parts were dropped by the same filter as `data-snippet` parts.
    const { mkdtempSync } = await import("node:fs");
    const { readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    hostWorkspaceDir = mkdtempSync(join(tmpdir(), "paco-attachment-test-"));

    // A 1x1 transparent PNG.
    const base64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    await runAgentWorkflow(
      makeOptions({
        messages: [
          {
            id: "user-1",
            role: "user" as const,
            parts: [
              { type: "text", text: "What is in this screenshot?" },
              {
                type: "file",
                mediaType: "image/png",
                filename: "shot.png",
                url: `data:image/png;base64,${base64}`,
              },
            ],
          },
        ],
      }),
    );

    const prompt = agentTurnCalls[0]?.prompt ?? "";
    expect(prompt).toContain("What is in this screenshot?");
    expect(prompt).toContain("shot.png");

    const pathMatch = prompt.match(/(\/\S*shot\.png)/);
    expect(pathMatch).not.toBeNull();
    const staged = await readFile(pathMatch?.[1] ?? "");
    expect(staged.toString("base64")).toBe(base64);
  });

  /**
   * Staging a PNG and telling the agent to `Read` it is only honest if the
   * agent can see one. Poolside's models cannot — verified live on both
   * `poolside/laguna-s-2.1` and `poolside/laguna-xs-2.1` against `pool`
   * 1.0.16 — so this is the point where the prompt has to stop implying
   * otherwise. Before this, a screenshot on a Poolside chat produced a
   * confident "Use `Read` on that path to view it." and a blind agent.
   */
  test("a blind backend is told plainly that it cannot see the attached image", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    hostWorkspaceDir = mkdtempSync(join(tmpdir(), "paco-attachment-test-"));
    testChatRecord = { ...testChatRecord, backend: "poolside" };

    const base64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    await runAgentWorkflow(
      makeOptions({
        messages: [
          {
            id: "user-1",
            role: "user" as const,
            parts: [
              { type: "text", text: "What is in this screenshot?" },
              {
                type: "file",
                mediaType: "image/png",
                filename: "shot.png",
                url: `data:image/png;base64,${base64}`,
              },
            ],
          },
        ],
      }),
    );

    const prompt = agentTurnCalls[0]?.prompt ?? "";
    expect(prompt).not.toContain("Use `Read` on that path to view it.");
    expect(prompt).toContain("You cannot see images");
    expect(prompt).toContain("NOT available to you");
    // Still staged and still named: moving the file, renaming it or checking
    // its size needs no eyes, and dropping it would remove a capability
    // Poolside genuinely has.
    expect(prompt).toContain("shot.png");
    expect(prompt).toMatch(/\/\S*shot\.png/);
  });

  test("a sighted backend's image prompt is unchanged", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    hostWorkspaceDir = mkdtempSync(join(tmpdir(), "paco-attachment-test-"));

    const base64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    await runAgentWorkflow(
      makeOptions({
        messages: [
          {
            id: "user-1",
            role: "user" as const,
            parts: [
              { type: "text", text: "What is in this screenshot?" },
              {
                type: "file",
                mediaType: "image/png",
                filename: "shot.png",
                url: `data:image/png;base64,${base64}`,
              },
            ],
          },
        ],
      }),
    );

    const prompt = agentTurnCalls[0]?.prompt ?? "";
    expect(prompt).toContain("Use `Read` on that path to view it.");
    expect(prompt).not.toContain("You cannot see images");
  });

  test("a message with no attachments still sends the plain text prompt", async () => {
    await runAgentWorkflow(makeOptions());

    expect(agentTurnCalls[0]?.prompt).toBe("Hello");
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
