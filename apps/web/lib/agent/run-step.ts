import "server-only";

import type {
  AgentBackend,
  BackendCapabilities,
  TurnUsage,
} from "@paco/agent-backend";
import {
  buildApprovalSettings,
  type ClaudeAgentDefinition,
  type ClaudeBackendOptions,
  DEFAULT_AGENTS,
} from "@paco/claude-code";
import type {
  OpenFxBackendOptions,
  OpenFxStdioMcpServer,
} from "@paco/openfx-backend";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { createOpenFxApprovalHandler } from "./approvals/openfx-approval";
import { type BackendSelectionInput, resolveBackend } from "./backend-factory";
import { buildAppendSystemPrompt } from "./system-prompt";
import type { AgentCallOptions, SteerController } from "./types";
import { hostWorkspaceFor } from "./workspace-paths";

export interface AgentStepResult<UI extends UIMessage> {
  responseMessage?: UI;
  usage: TurnUsage;
  finishReason: "stop" | "length" | "error" | "tool-calls";
  /**
   * This turn's resume token, under whichever backend actually ran it —
   * despite the name, not Claude-specific: `resolveBackend`'s result
   * decides the backend, and the caller (the chat workflow) is what scopes
   * this by backend id before persisting it (`setChatResumeToken` in
   * `lib/db/sessions.ts`). Left named `claudeSessionId` rather than
   * renamed, to avoid rippling the change through every caller for a field
   * whose meaning ("this turn's resume token") was already documented as
   * backend-neutral before OpenFX existed.
   */
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
 * The model id to hand this backend, or nothing.
 *
 * `capabilities().models` is the backend's own answer to "which of the
 * picker's ids do I accept": `undefined` means the app's catalog applies
 * unchanged (Claude Code, whose tier aliases the catalog is written in), and
 * an empty array means the backend resolves its own model and takes none.
 * Forwarding regardless is how `--model opus` — a Claude tier alias — was
 * being handed to the OpenFX binary, which has never heard of it.
 */
function resolveModelId(
  capabilities: BackendCapabilities,
  modelId: string | undefined,
): string | undefined {
  if (modelId === undefined || capabilities.models === undefined) {
    return modelId;
  }
  return capabilities.models.includes(modelId) ? modelId : undefined;
}

/**
 * The turn's `gh` credentials, as environment variables.
 *
 * Shared by both backends: without them the CLI falls back to the host's
 * keyring login and the agent pushes and opens pull requests as whoever set
 * up the machine, which is the exact thing AGENTS.md's GitHub section exists
 * to prevent (`lib/github/gh.ts` pins every one of Paco's own calls the same
 * way). In the environment and never in argv — `ps` shows one process's
 * arguments to every user on the machine.
 */
function githubTokenEnv(token: string | undefined): Record<string, string> {
  if (token === undefined) {
    return {};
  }
  return { GH_TOKEN: token, GITHUB_TOKEN: token };
}

/**
 * Paco's name-keyed MCP config, as the array OpenFX's parser wants.
 *
 * Two shapes, not one: the Claude Code CLI takes `--mcp-config`'s
 * `{ "<name>": { command, args, env } }` record, while ACP's `session/new`
 * takes a list whose entries each carry their own `name`
 * (`openfx/src/acp/mcp_servers.zig:177-221`). The same source rejects a
 * relative `command` outright (`CommandNotAbsolute`), which would fail the
 * WHOLE session rather than just that one server — so a relative command is
 * dropped with a warning instead, leaving the rest of the turn's servers
 * working. In practice nothing hits that: `buildPluginMcpConfig` uses
 * `process.execPath`.
 */
function toOpenFxMcpServers(
  mcpServers: NonNullable<AgentCallOptions["mcpServers"]>,
): OpenFxStdioMcpServer[] {
  const servers: OpenFxStdioMcpServer[] = [];
  for (const [name, server] of Object.entries(mcpServers)) {
    if (!server.command.startsWith("/")) {
      console.warn(
        `[run-step] Skipping MCP server "${name}" for OpenFX: its command must be an absolute path, got "${server.command}".`,
      );
      continue;
    }
    servers.push({
      name,
      command: server.command,
      args: server.args,
      env: server.env,
    });
  }
  return servers;
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
  /**
   * Which `AgentBackend` this chat runs on (`chats.backend`) — resolved to a
   * real backend instance via `resolveBackend`, unless `params.backend`
   * already supplies one (see that field's own doc).
   */
  chatBackend?: BackendSelectionInput["backend"];
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
  /**
   * Overrides `resolveBackend(params.chatBackend)`. Real callers never set
   * this — the chat's own `backend` column decides — but tests use it to
   * inject `FakeBackend`/a spy without touching the database.
   */
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

  const backend =
    params.backend ?? (await resolveBackend({ backend: params.chatBackend }));
  const capabilities = backend.capabilities();
  const backendId = capabilities.id;

  /*
   * A turn asking for shaped output on a backend that cannot produce it gets
   * free text back and `structuredOutput: undefined` — which the caller
   * (`lib/tasks/planner.ts`, `lib/tasks/reviewer-gate.ts`) reads as "the
   * model answered badly" rather than "this backend was never able to
   * answer". Nothing here can make ACP grow a JSON Schema parameter, so the
   * least this can do is refuse to be silent about it; the real fix is for
   * those callers to consult `capabilities().structuredOutput` before
   * offering the feature at all.
   */
  if (options.structuredOutput && capabilities.structuredOutput === false) {
    console.warn(
      `[run-step] Backend "${backendId}" cannot constrain output with a JSON schema; this turn's structuredOutput will be undefined.`,
    );
  }

  const modelId = resolveModelId(capabilities, options.model?.id);

  const hostCwd = resolveHostCwd(options);

  /*
   * Each backend gets its own options shape (`ClaudeBackendOptions` vs.
   * `OpenFxBackendOptions` — `TurnContext.backendOptions` is an intentionally
   * untyped bag per backend, see `@paco/agent-backend`'s `interface.ts`), so
   * this branches on which backend was actually resolved rather than trying
   * to force one shape to describe both.
   */
  const backendOptions: ClaudeBackendOptions | OpenFxBackendOptions =
    backendId === "openfx"
      ? ({
          ...(modelId ? { model: modelId } : {}),
          /*
           * The same instructions the Claude branch passes as
           * `appendSystemPrompt`. ACP has no system-prompt parameter, so
           * `OpenFxBackendOptions.systemContext` rides in as a leading text
           * block on `session/prompt` (see its doc for why that is a real
           * mechanism and not a workaround). Dropping it — which is what
           * used to happen — takes memory, skills, project instructions,
           * the environment details and the "## Running the app" briefing
           * with it, and an agent without that last one starts its dev
           * server on the host, where the container's preview URL cannot
           * reach it.
           */
          ...(appendSystemPrompt && { systemContext: appendSystemPrompt }),
          /*
           * One `openfx acp` process per turn, so per-turn env reaches the
           * agent's own `gh`. Unlike the Claude branch there are no
           * PACO_APPROVAL_* vars: approvals come back over the ACP
           * connection itself, not through a spawned hook.
           */
          ...(params.githubToken
            ? { env: githubTokenEnv(params.githubToken) }
            : {}),
          ...(options.mcpServers && {
            mcpServers: toOpenFxMcpServers(options.mcpServers),
          }),
          /*
           * Not passed, because OpenFX cannot take them — declared as
           * `customAgents: false` / `structuredOutput: false` /
           * `models: []` on its capabilities rather than left as a silent
           * omission here: `agents` (no ACP method installs a roster),
           * `jsonSchema` (no shaped output), `effort` (no ACP setter —
           * PROTOCOL.md §7), `tools`/`disallowedTools`/`permissionMode`
           * (tool policy is the `session/request_permission` handler
           * below, not a flag), and `maxTurns`.
           */
          // ACP delivers `session/request_permission` over the connection
          // this backend already owns, so the same `decideApproval` policy
          // Claude's PreToolUse hook uses is wired in-process here instead
          // of through a spawned hook + HTTP round trip — see
          // `openfx-approval.ts`'s doc.
          ...(params.approval && params.chatId
            ? {
                onApprovalRequest: createOpenFxApprovalHandler({
                  chatId: params.chatId,
                  worktree: hostCwd,
                }),
              }
            : {}),
        } satisfies OpenFxBackendOptions)
      : ({
          ...(params.approval && params.chatId
            ? { settings: buildApprovalSettings() }
            : {}),
          env: {
            ...githubTokenEnv(params.githubToken),
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
          model: modelId,
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
          ...(options.mcpServers && { mcpServers: options.mcpServers }),
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
        } satisfies ClaudeBackendOptions);

  const handle = backend.startTurn({
    cwd: hostCwd,
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
