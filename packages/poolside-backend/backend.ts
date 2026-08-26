import {
  type AgentBackend,
  type BackendCapabilities,
  type TurnContext,
  type TurnFinishReason,
  type TurnHandle,
  type TurnResult,
} from "@paco/agent-backend";
import type { UIMessageChunk } from "ai";
import { AcpClient } from "./acp-client.ts";
import type {
  ContentBlock,
  EarlyConfigOption,
  InitializeParams,
  PermissionDecision,
  PermissionHandler,
  PermissionRequestParams,
  PoolsideMcpServer,
  PoolsideUsage,
  PromptResult,
  SessionUpdateEnvelope,
  StopReason,
} from "./acp-types.ts";
import { PoolsideChunkMapper } from "./chunk-mapper.ts";
import {
  POOLSIDE_MODEL_IDS,
  type PoolsideBackendConfig,
  type PoolsideThoughtLevel,
} from "./config.ts";
import { readUsageUpdate, toTurnUsage } from "./usage.ts";

/**
 * One image for a turn's prompt.
 *
 * `initialize` reports `promptCapabilities: {image: true}`, which is why
 * this exists at all — OpenFX rejected images outright. Typed from that
 * advertisement; no live image turn was run (see this package's report on
 * what was verified live versus by test).
 */
export interface PoolsideImageBlock {
  /** e.g. `"image/png"`. */
  mimeType: string;
  /** Base64, without a data-URL prefix. */
  data: string;
}

/**
 * Per-turn options for the Poolside backend, read from
 * `TurnContext.backendOptions`.
 */
export interface PoolsideBackendOptions {
  /**
   * The model for this turn — one of `POOLSIDE_MODEL_IDS`.
   *
   * Applied as the `model` config option: through
   * `session/new`'s `_meta["poolside/early_session_config_options"]` on a
   * fresh session, and through `session/set_config_option` on a resumed
   * one (`session/load` takes no early options). An id Poolside does not
   * recognise fails the turn rather than being dropped — a silently
   * ignored model choice is how a user ends up billed for, and reasoning
   * with, a model they didn't pick.
   */
  model?: string;
  /**
   * Poolside's `thought_level`, its only reasoning-effort knob.
   *
   * Named for the Poolside concept rather than Paco's "effort" on purpose:
   * `capabilities().effort` is `false` because this switch has two
   * positions and Paco's effort vocabulary has five, so nothing forwards
   * the picker's value here automatically. See `poolsideThoughtLevel` for
   * the mapping, and its doc for why the capability is declared false.
   * Unset leaves the session default (`max`).
   */
  thoughtLevel?: PoolsideThoughtLevel;
  /** Poolside's `agent_mode`: `build` executes changes, `plan` does not. */
  agentMode?: "build" | "plan";
  /**
   * Poolside's `mode` config option — its OWN approval policy.
   *
   * Deliberately unset by default, which leaves it at `"default"` so every
   * tool call arrives as a `session/request_permission` for
   * `onApprovalRequest` (and therefore Paco's `decideApproval`) to answer.
   * Setting `"always-allow"` bypasses Paco's approval policy entirely
   * inside the agent, so it exists only as an explicit, deliberate escape
   * hatch.
   */
  permissionMode?: "default" | "accept-edits" | "always-allow";
  /**
   * Instructions to put in front of this turn's user prompt: the caller's
   * memory section, skills, project instructions, environment briefing —
   * everything `ClaudeBackendOptions.appendSystemPrompt` carries there.
   *
   * It rides in as a leading `text` content block, NOT as a system prompt,
   * and that is not a shortcut. `initialize` advertises
   * `_meta["poolside/system_prompt"]`, but what that flag enables is the
   * `_poolside/session_system_prompt` REQUEST, which READS the effective
   * prompt (the Poolside TUI uses it to display one). It is not a setter:
   * passing a `systemPrompt` to it returns the default unchanged, and
   * `session/new` has no such parameter under any spelling
   * (`systemPrompt`, `instructions`, or `_meta["poolside/system_prompt"]`
   * as a string, an object, or an `{append}`), nor does
   * `pool acp --settings` (`system_message`, `instructions`,
   * `agent.instructions`, `agent.system_message`). All of that was tried
   * against the live binary and none of it moved the prompt by a byte.
   *
   * The only channel that does is an `AGENTS.md` in the session cwd, which
   * `pool` inlines as `<agents_md>` — a per-repository file, not a
   * per-turn parameter, so it cannot carry a memory section scored against
   * this prompt.
   *
   * The cost is the one OpenFX paid: this lands IN the session history, so
   * a long chat carries one copy per turn. That is accepted rather than
   * dropping the instructions, because without them the agent has no
   * memory, no skills and no "## Running the app" briefing, and starts its
   * dev server on the host where the preview cannot reach it.
   */
  systemContext?: string;
  /** Images for this turn's prompt, appended after the text blocks. */
  images?: PoolsideImageBlock[];
  /**
   * MCP servers for this turn's session.
   *
   * Genuinely attached, not merely accepted: a stub server passed here is
   * spawned by `pool` and completes a full MCP handshake
   * (`initialize` / `notifications/initialized` / `tools/list`) with the
   * `env` given. That distinction is the whole reason `capabilities().mcp`
   * is `true` here and was a lie for OpenFX.
   *
   * Stdio only — `initialize` reports `mcpCapabilities: {}`, so there is no
   * http/sse transport to offer.
   */
  mcpServers?: PoolsideMcpServer[];
  /**
   * Environment for THIS turn's process, layered over
   * `PoolsideBackendConfig.env` (the instance-wide credentials).
   *
   * One `pool acp` process per turn is what makes per-turn environment
   * meaningful: it is how a turn's own `GH_TOKEN`/`GITHUB_TOKEN` reach the
   * agent's `gh`, instead of `gh` falling back to the host keyring and
   * acting as whoever ran `gh auth login` on the machine.
   */
  env?: Record<string, string>;
  /**
   * Answers this turn's `session/request_permission` round trips.
   *
   * ACP delivers the permission request as a JSON-RPC request over the
   * connection this backend already owns, so unlike @paco/claude-code's
   * PreToolUse hook there is no subprocess and no HTTP round trip to
   * reproduce: a caller wires this the same way it wires the Claude hook's
   * endpoint — call `decideApproval`, translate allow/deny into a
   * `PermissionDecision` — just in-process.
   *
   * Falls back to the constructor's `permissionHandler`, then to a
   * built-in handler that always denies.
   */
  onApprovalRequest?: PermissionHandler;
}

/**
 * `initialize`'s clientCapabilities: false across the board.
 *
 * Nothing in Poolside's server-to-client message set exercises a
 * client-side `fs.readTextFile`/`writeTextFile` or a terminal — the agent
 * reads and writes files through its own sandboxed tools — so claiming any
 * of them would be an unfulfillable promise.
 */
const INITIALIZE_PARAMS: InitializeParams = {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
};

/** Poolside's config-option ids, as `session/new` reports them. */
const CONFIG_ID = {
  agentMode: "agent_mode",
  mode: "mode",
  model: "model",
  thoughtLevel: "thought_level",
} as const;

/**
 * The turn's content blocks: the caller's instructions first, then the user
 * prompt, then any images.
 *
 * Two `text` blocks rather than one concatenated string, so the boundary
 * survives on the wire and stays readable in a log.
 */
function promptBlocks(
  options: PoolsideBackendOptions,
  prompt: string,
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (options.systemContext !== undefined && options.systemContext !== "") {
    blocks.push({ type: "text", text: options.systemContext });
  }
  blocks.push({ type: "text", text: prompt });
  for (const image of options.images ?? []) {
    blocks.push({ type: "image", mimeType: image.mimeType, data: image.data });
  }
  return blocks;
}

/** The config options a turn wants set, as `{configId, value}` pairs. */
function configOptionsFor(
  options: PoolsideBackendOptions,
): EarlyConfigOption[] {
  const wanted: EarlyConfigOption[] = [];
  if (options.permissionMode) {
    wanted.push({ configId: CONFIG_ID.mode, value: options.permissionMode });
  }
  if (options.agentMode) {
    wanted.push({ configId: CONFIG_ID.agentMode, value: options.agentMode });
  }
  if (options.thoughtLevel) {
    wanted.push({
      configId: CONFIG_ID.thoughtLevel,
      value: options.thoughtLevel,
    });
  }
  if (options.model) {
    wanted.push({ configId: CONFIG_ID.model, value: options.model });
  }
  return wanted;
}

function abortError(): Error {
  const error = new Error("Poolside turn was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Default `permissionHandler`: always denies.
 *
 * Selects the server's `reject_once` option when one is offered — an
 * explicit, auditable denial — rather than `outcome: "cancelled"`, which is
 * indistinguishable server-side from a client that simply gave up on the
 * request. Exported so tests can assert its exact shape without spawning a
 * process; the constructor wires it in automatically.
 */
export function denyPermissionHandler(
  request: PermissionRequestParams,
): PermissionDecision {
  const rejectOption = request.options.find(
    (option) => option.optionId === "reject_once",
  );
  if (rejectOption) {
    return {
      outcome: { outcome: "selected", optionId: rejectOption.optionId },
    };
  }
  return { outcome: { outcome: "cancelled" } };
}

function toFinishReason(stopReason: StopReason): TurnFinishReason {
  switch (stopReason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
    case "max_output_tokens":
    case "max_turn_requests":
      return "length";
    case "refusal":
    case "refused":
      return "error";
    case "cancelled":
      // Unreachable in practice: a cancelled turn is intercepted before
      // this is called and reported as AbortError/steered. Kept so the
      // switch stays exhaustive over StopReason.
      return "stop";
    default:
      return "stop";
  }
}

/**
 * Did the agent report the task as failed?
 *
 * `_meta["poolside/task_outcome"]` is `{success: boolean}` on a completed
 * turn. Only an explicit `success: false` counts as an error — a missing
 * outcome (as on a cancelled turn) is not evidence of failure. A refusal
 * stop reason is treated as an error regardless.
 */
function isErrorResult(result: PromptResult): boolean {
  if (result.stopReason === "refusal" || result.stopReason === "refused") {
    return true;
  }
  const outcome = result._meta?.["poolside/task_outcome"];
  if (typeof outcome === "object" && outcome !== null) {
    return (outcome as { success?: unknown }).success === false;
  }
  return false;
}

/** A handle for a turn that never started because the signal was already aborted. */
function preAbortedHandle(): TurnHandle {
  const rejected = Promise.reject<TurnResult>(abortError());
  rejected.catch(() => undefined);
  return {
    chunks: (async function* empty(): AsyncGenerator<UIMessageChunk> {
      // Intentionally empty: the turn never started.
    })(),
    result: rejected,
    steer: () => Promise.resolve(),
    interrupt: () => {
      // No-op: there is nothing running to interrupt.
    },
  };
}

type UpdateRaceOutcome =
  | { kind: "update"; result: IteratorResult<SessionUpdateEnvelope> }
  | { kind: "done" };

/**
 * `AgentBackend` over the Poolside CLI's ACP transport (`pool acp`).
 *
 * One `AcpClient` — one `pool acp` process — per turn. A session's
 * workspace root is fixed at `session/new` time, so a chat cannot share one
 * long-lived process across turns and worktrees; `ctx.resumeToken` (the ACP
 * `sessionId`) is what lets a NEW process reattach to the SAME conversation
 * through `session/load`, verified across processes.
 *
 * Steering is `"restart"`, the same shape as `ClaudeCodeBackend`: steer()
 * winds the turn down and reports it as cleanly steered, and the caller
 * starts the next turn with the steer text and the returned resumeToken.
 * Poolside does have native mid-turn steering
 * (`_poolside/session_steer`, keyed to an `inputId` echoed back in
 * `session_info_update._meta["poolside/inputEventId"]`, and it genuinely
 * redirects a running turn), but `BackendCapabilities.steering` has no
 * value meaning "inject into a running turn" and the contract for
 * `"restart"` requires the turn to END carrying the text. Reporting
 * `"restart"` and behaving that way is the honest option; injecting AND
 * resolving `steered` would send the text twice.
 *
 * Two Poolside-specific hazards this class exists to absorb:
 *
 * 1. `session/cancel` resolves the running `session/prompt` with
 *    `stopReason: "end_turn"`, NOT `"cancelled"`. So cancellation is
 *    tracked with `cancelledByUs` and the wire's stop reason is never
 *    trusted for it.
 * 2. `session/load` replays the entire conversation as `session/update`
 *    notifications before answering. `chunks` is therefore held closed
 *    until the replay has been discarded, so a resumed turn streams its own
 *    output and not a duplicate transcript.
 */
export class PoolsideBackend implements AgentBackend {
  private readonly config: PoolsideBackendConfig;

  constructor(config: PoolsideBackendConfig = {}) {
    this.config = config;
  }

  capabilities(): BackendCapabilities {
    return {
      id: "poolside",
      // `session/load` reattaches a fresh process to an existing session —
      // verified across processes, replaying the conversation.
      resume: true,
      steering: "restart",
      // True, and load-bearing: an stdio MCP server passed to a turn is
      // really spawned and handshaken. See PoolsideBackendOptions.mcpServers.
      mcp: true,
      // `thought_level` exists (max | none) but `BackendCapabilities.effort`
      // is a bare boolean, so `true` would mean "forward Paco's five-level
      // picker" — four of whose levels would collapse invisibly onto two.
      // See `poolsideThoughtLevel` for the full reasoning; the knob is
      // still reachable through `PoolsideBackendOptions.thoughtLevel`.
      effort: false,
      // Poolside delegates to its own subagents (usage `_meta` carries
      // `poolside/subagentTotals`), so the UI should know they exist.
      subagents: true,
      // ...but the client cannot INSTALL a roster.
      // `_meta["poolside/session_agent_config"]` selects an already-defined
      // agent — it demands an agent id and name — and nothing in the
      // catalog carries agent definitions, so Paco's Section 3 roster and
      // its per-agent model tiers have no way in.
      customAgents: false,
      // No JSON-Schema-constrained output anywhere: a turn returns a stop
      // reason, usage, and streamed text.
      structuredOutput: false,
      // Unlike OpenFX, model selection is real: these ids come from the
      // live `model` config option. See POOLSIDE_MODEL_IDS.
      models: this.config.models ?? POOLSIDE_MODEL_IDS,
    };
  }

  startTurn(ctx: TurnContext): TurnHandle {
    if (ctx.abortSignal?.aborted) {
      return preAbortedHandle();
    }

    const backendOptions = (ctx.backendOptions ?? {}) as PoolsideBackendOptions;
    const permissionHandler: PermissionHandler =
      backendOptions.onApprovalRequest ??
      this.config.permissionHandler ??
      denyPermissionHandler;

    const client = new AcpClient({
      cwd: ctx.cwd,
      executable: this.config.executable,
      extraArgs: this.config.extraArgs,
      sandbox: this.config.sandbox,
      settings: this.config.settings,
      // Per-turn env last, so a turn's own `GH_TOKEN` wins over anything
      // the instance-wide config set under the same name.
      env: { ...this.config.env, ...backendOptions.env },
      closeTimeoutsMs: this.config.closeTimeoutsMs,
    });
    client.onPermissionRequest(permissionHandler);

    const mapper = new PoolsideChunkMapper();
    const wanted = configOptionsFor(backendOptions);
    let sessionId: string | undefined;
    let steerText: string | undefined;
    let cancelledByUs = false;
    /** The last `usage_update` seen — the only usage a cancelled turn has. */
    let streamedUsage: PoolsideUsage | undefined;

    function cancelAndClose(): void {
      cancelledByUs = true;
      if (sessionId) {
        client.cancel(sessionId);
      }
      // With no session yet there is nothing for session/cancel to target;
      // orchestrate() re-sends it once one exists, rather than tearing the
      // connection down here and stranding session/new before it can hand
      // back a sessionId to use as the resumeToken.
    }

    const onOuterAbort = () => cancelAndClose();
    ctx.abortSignal?.addEventListener("abort", onOuterAbort, { once: true });

    function buildSteeredResult(text: string): TurnResult {
      return {
        finishReason: "stop",
        isError: false,
        // A steered turn still burned tokens; the last `usage_update` is
        // the only record of them, since a cancelled `session/prompt`
        // answers with no `usage` at all.
        usage: toTurnUsage(undefined, streamedUsage, backendOptions.model),
        ...(sessionId ? { resumeToken: sessionId } : {}),
        steered: { text },
      };
    }

    // Settled by orchestrate() with the turn's outcome. chunksGen() reads
    // it only via `.then`, never awaits it, purely to know when to stop
    // draining `client.updates`.
    const promptDeferred = Promise.withResolvers<PromptResult>();
    promptDeferred.promise.catch(() => undefined);

    /**
     * Resolved by orchestrate() once the session exists, any replayed
     * history has been discarded, and the prompt is about to go out.
     * chunksGen() waits on this before touching `client.updates` — that is
     * what keeps a resumed turn from re-emitting the whole conversation.
     */
    const readyDeferred = Promise.withResolvers<undefined>();
    readyDeferred.promise.catch(() => undefined);

    // Resolved only by chunksGen()'s normal-completion path. Exists so the
    // normal-completion branch of `transportResult` can wait for it:
    // without it, `result` would settle as soon as the ACP turn finished
    // regardless of whether the caller ever looked at `chunks`, violating
    // the CONTRACT ("result settles only after chunks is fully consumed").
    // The orchestration itself still runs eagerly; only the value exposed
    // through `result` is gated.
    const chunksDrained = Promise.withResolvers<undefined>();
    chunksDrained.promise.catch(() => undefined);

    async function orchestrate(): Promise<void> {
      try {
        await client.initialize(INITIALIZE_PARAMS);

        if (ctx.resumeToken) {
          sessionId = ctx.resumeToken;
          await client.loadSession({
            sessionId: ctx.resumeToken,
            cwd: ctx.cwd,
            mcpServers: backendOptions.mcpServers,
          });
          // The conversation has just been replayed at us. Everything
          // buffered is history; drop it before anyone can map it.
          client.discardBufferedUpdates();
          // session/load takes no early config options, so a resumed turn
          // sets them one at a time. An unknown option or value fails the
          // turn rather than being swallowed — a model choice that
          // silently does nothing is worse than one that says so.
          for (const option of wanted) {
            await client.setConfigOption(
              sessionId,
              option.configId,
              option.value,
            );
          }
        } else {
          const session = await client.newSession({
            cwd: ctx.cwd,
            mcpServers: backendOptions.mcpServers,
            configOptions: wanted,
          });
          sessionId = session.sessionId;
          // session/new emits an available_commands_update of its own;
          // dropping it keeps both paths symmetric.
          client.discardBufferedUpdates();
        }

        if (cancelledByUs) {
          // A steer/interrupt arrived before a session existed to target —
          // send it now that one does, rather than losing it.
          client.cancel(sessionId);
        }

        readyDeferred.resolve(undefined);

        const promptPromise = client.prompt({
          sessionId,
          prompt: promptBlocks(backendOptions, ctx.prompt),
        });
        if (cancelledByUs) {
          // Covers the narrow window between the check above and this
          // request going out: a session/cancel that lands before
          // session/prompt begins has nothing to cancel, so re-sending it
          // immediately after — guaranteed ordered after, on the same
          // stdio stream — is what actually takes effect.
          client.cancel(sessionId);
        }
        promptDeferred.resolve(await promptPromise);
      } catch (error) {
        promptDeferred.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      } finally {
        // Unblocks chunksGen() if we failed before ever getting ready.
        readyDeferred.resolve(undefined);
        // One AcpClient per turn: always torn down here, whatever happened.
        await client.close();
      }
    }

    void orchestrate();

    // Settled from chunksGen()'s `finally` when the caller abandons
    // `chunks` before the turn ends — the CONTRACT treats that as
    // equivalent to interrupt().
    const abandonment = Promise.withResolvers<TurnResult>();
    abandonment.promise.catch(() => undefined);

    const transportResult: Promise<TurnResult> = promptDeferred.promise.then(
      async (promptResult): Promise<TurnResult> => {
        // Checked here as well as below because Poolside answers a
        // cancelled prompt with a perfectly ordinary `end_turn`: a
        // steer/interrupt must still report AbortError/steered even though
        // the transport reports a normal completion. This branch keeps
        // those semantics and does NOT wait on `chunksDrained` —
        // abandonment settles through its own race, and steer/interrupt
        // are defined to settle `result` independently of chunk
        // consumption.
        if (promptResult.stopReason === "cancelled" || cancelledByUs) {
          if (steerText !== undefined) {
            return buildSteeredResult(steerText);
          }
          throw abortError();
        }
        // Normal completion: the CONTRACT requires `result` to settle only
        // once the caller has fully drained `chunks`.
        await chunksDrained.promise;
        return {
          finishReason: toFinishReason(promptResult.stopReason),
          isError: isErrorResult(promptResult),
          usage: toTurnUsage(
            promptResult.usage,
            streamedUsage,
            backendOptions.model,
          ),
          ...(sessionId ? { resumeToken: sessionId } : {}),
        };
      },
      (error: unknown): TurnResult => {
        if (cancelledByUs) {
          if (steerText !== undefined) {
            return buildSteeredResult(steerText);
          }
          throw abortError();
        }
        throw error instanceof Error ? error : new Error(String(error));
      },
    );

    const result: Promise<TurnResult> = Promise.race([
      transportResult,
      abandonment.promise,
    ]);
    // The workflow may consume chunks and result independently; an abort
    // rejection must not become an unhandled rejection before it's awaited.
    result.catch(() => undefined);
    result
      .finally(() => {
        ctx.abortSignal?.removeEventListener("abort", onOuterAbort);
      })
      .catch(() => undefined);

    async function* chunksGen(): AsyncGenerator<UIMessageChunk> {
      let completed = false;
      try {
        const donePromise: Promise<"done"> = promptDeferred.promise.then(
          () => "done",
          () => "done",
        );
        // Nothing is read from `client.updates` until orchestrate() says
        // the session is prepared and any replayed history discarded —
        // that gate is what keeps a resumed turn from re-emitting the
        // whole conversation.
        //
        // Awaited outright rather than raced against `donePromise`:
        // orchestrate() resolves this in its `finally`, so it always
        // settles, even when setup itself failed. Racing it would be
        // actively wrong — on a turn that finished before the caller ever
        // touched `chunks`, `donePromise` (attached to an
        // already-resolved promise one line earlier) settles first, and
        // this generator would skip the buffered updates and yield
        // nothing.
        await readyDeferred.promise;

        const iterator = client.updates[Symbol.asyncIterator]();
        for (;;) {
          const winner: UpdateRaceOutcome = await Promise.race([
            // First in the array on purpose: when updates are already
            // buffered, `next()` is an already-resolved promise and wins
            // the race against an already-settled `donePromise`, so a fast
            // turn's chunks are still delivered. Only an EMPTY queue lets
            // `done` through.
            iterator
              .next()
              .then((r): UpdateRaceOutcome => ({ kind: "update", result: r })),
            donePromise.then((kind): UpdateRaceOutcome => ({ kind })),
          ]);
          if (winner.kind === "done" || winner.result.done) {
            break;
          }
          const update = winner.result.value.update;
          // Usage rides the same stream as the content chunks, and is read
          // here rather than in the mapper so the mapper stays a pure
          // update-to-chunk function.
          streamedUsage = readUsageUpdate(update) ?? streamedUsage;
          for (const chunk of mapper.map(update)) {
            yield chunk;
          }
        }
        for (const chunk of mapper.finish()) {
          yield chunk;
        }
        completed = true;
        chunksDrained.resolve(undefined);
      } finally {
        // A consumer that abandons `chunks` early (break/return/throw)
        // resumes this generator here without `completed` ever being set.
        // Per the CONTRACT that is equivalent to interrupt(): make sure
        // `result` still settles rather than dangling, and that the
        // process is actually torn down.
        if (!completed) {
          // Close the mapper's own state even though its output is
          // discarded — nothing should be yielded from a `finally`
          // mid-forced-return, but the mapper must not be left thinking a
          // text or reasoning block is still open.
          mapper.finish();
          cancelAndClose();
          if (steerText !== undefined) {
            abandonment.resolve(buildSteeredResult(steerText));
          } else {
            abandonment.reject(abortError());
          }
        }
      }
    }

    return {
      chunks: chunksGen(),
      result,
      steer: (text: string) => {
        steerText = text;
        cancelAndClose();
        return Promise.resolve();
      },
      interrupt: () => {
        cancelAndClose();
      },
    };
  }
}
