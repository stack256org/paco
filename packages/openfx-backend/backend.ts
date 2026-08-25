import {
  type AgentBackend,
  type BackendCapabilities,
  type TurnContext,
  type TurnFinishReason,
  type TurnHandle,
  type TurnResult,
  zeroUsage,
} from "@paco/agent-backend";
import type { UIMessageChunk } from "ai";
import {
  AcpClient,
  type InitializeParams,
  type McpServerConfig,
  type PermissionDecision,
  type PermissionHandler,
  type PermissionRequestParams,
  type SessionUpdateEnvelope,
  type StopReason,
} from "./acp-client.ts";
import { AcpChunkMapper } from "./chunk-mapper.ts";

/**
 * Per-turn options for the OpenFX backend, read from
 * `TurnContext.backendOptions` (interface.ts leaves that bag
 * backend-specific — this is this backend's shape).
 */
export interface OpenFxBackendOptions {
  /** MCP servers for this turn's session — PROTOCOL.md §7 `capabilities().mcp`. */
  mcpServers?: McpServerConfig[];
  /** `--model` override for this turn's process — PROTOCOL.md §1. */
  model?: string;
  /**
   * Answers this turn's `session/request_permission` round trips
   * (PROTOCOL.md §5).
   *
   * Mirrors the seam @paco/claude-code's PreToolUse hook feeds
   * `decideApproval` through (approval.ts's `HOOK_SOURCE`: a spawned
   * subprocess posts the tool call to an HTTP endpoint, which calls
   * `decideApproval` and answers allow/deny) — not the mechanism. ACP
   * already delivers the permission request as a JSON-RPC request over the
   * same connection this backend owns, so there is no hook subprocess and
   * no HTTP round trip to reproduce: a caller (run-step) wires this the
   * same way it wires the Claude hook's endpoint — call `decideApproval`,
   * translate its allow/deny into an ACP `PermissionDecision` — just
   * in-process instead of over HTTP.
   *
   * Falls back to the constructor's `permissionHandler`, and then to a
   * built-in handler that always denies.
   */
  onApprovalRequest?: PermissionHandler;
}

/** Constructor options for {@link OpenFxBackend}. */
export interface OpenFxBackendConfig {
  /** Real invocation is the `openfx` binary — PROTOCOL.md §1. */
  executable?: string;
  /**
   * Provider/credential env vars layered over AcpClient's minimal base
   * (PATH, HOME) — see `AcpClientOptions.env`'s doc for the PROTOCOL.md §1
   * variable list (`OPENFX_MODEL`, `VERCEL_OIDC_TOKEN`,
   * `AI_GATEWAY_API_KEY`, ...).
   */
  env?: Record<string, string>;
  /**
   * Default answer for `session/request_permission` when a turn doesn't
   * supply `OpenFxBackendOptions.onApprovalRequest`. Defaults to a handler
   * that always denies.
   */
  permissionHandler?: PermissionHandler;
  /**
   * Extra argv inserted before the `acp` subcommand. Production code never
   * sets this; tests point it at `test/stub-acp-server.ts`, the same way
   * `acp-client.test.ts` does (see `AcpClientOptions.extraArgs`).
   */
  extraArgs?: string[];
  /** Forwarded to AcpClient — see `AcpClientOptions.closeTimeoutsMs`. */
  closeTimeoutsMs?: { graceful?: number; term?: number };
}

/**
 * initialize's clientCapabilities. Declared false across the board: nothing
 * in PROTOCOL.md's message catalog gives the ACP *server* a request type to
 * actually exercise a client-side fs.readTextFile/writeTextFile or terminal
 * capability, so claiming any of them would be an unfulfillable promise
 * rather than a real one.
 */
const INITIALIZE_PARAMS: InitializeParams = {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
};

function abortError(): Error {
  const error = new Error("OpenFX turn was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Default `permissionHandler`: always denies. Selects the `reject_once`
 * option when the server offered one (an explicit, auditable denial) rather
 * than the ambiguous `outcome:"cancelled"` shape, which PROTOCOL.md §8 gap 6
 * notes is indistinguishable server-side from a client that simply gave up
 * on the request. Exported so backend.test.ts can assert its exact shape
 * without spawning a process for that alone; the constructor wires it in
 * automatically, so nothing else needs to reference it.
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
    case "max_output_tokens":
    case "max_model_turns":
      return "length";
    case "refused":
      return "error";
    case "cancelled":
      // Unreachable in practice: startTurn() intercepts "cancelled" before
      // calling this and reports AbortError/steered instead (see below).
      // Kept only so this switch stays exhaustive over StopReason.
      return "stop";
    default:
      return "stop";
  }
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
 * AgentBackend implementation over the OpenFX ACP transport
 * (`acp-client.ts`, `chunk-mapper.ts`; see PROTOCOL.md throughout).
 *
 * One `AcpClient` (one `openfx acp` process) per turn — PROTOCOL.md §1: the
 * workspace root is bound once at `initialize` time from the process's own
 * cwd, so a chat can't share one long-lived process across turns/worktrees.
 * `ctx.resumeToken` (the ACP `sessionId` — the durable, on-disk handle
 * PROTOCOL.md §4 describes) is what lets a *new* process reattach to the
 * *same* conversation via `session/load`.
 *
 * Steering is "restart", the same shape as `ClaudeCodeBackend`: steer()
 * cancels the current turn and reports it as cleanly steered; the caller
 * starts the next turn with the steer text and the returned resumeToken,
 * which is what actually resumes the session (PROTOCOL.md §7 steering row —
 * ACP has no method to inject text into a running prompt).
 *
 * Unlike `ClaudeCodeBackend`, `ctx.abortSignal`'s listener is removed in
 * exactly one place (`result.finally(...)`), not also from `chunks`'s own
 * `finally`. That's safe here specifically because `orchestrate()` runs
 * detached (`void orchestrate()`) from a top-level `try/finally` that always
 * settles `stopReasonDeferred` and therefore `result` — whether the caller
 * ever reads `chunks` or not. `ClaudeCodeBackend` needs a second cleanup
 * site because its transport result can, in the abandonment case, depend on
 * `chunks` having been driven forward at all (see its own comment on
 * `abandonment`); this backend's `result` always settles on its own, so one
 * cleanup site suffices.
 */
export class OpenFxBackend implements AgentBackend {
  private readonly config: OpenFxBackendConfig;

  constructor(config: OpenFxBackendConfig = {}) {
    this.config = config;
  }

  capabilities(): BackendCapabilities {
    // PROTOCOL.md §7 "Verdict": {resume:true, steering:"restart", mcp:true,
    // effort:false, subagents:true} — subagents run internally but are
    // indistinguishable on the wire from an ordinary tool call (§7 caveat),
    // still counted true since Paco's UI only needs to know they exist.
    return {
      id: "openfx",
      resume: true,
      steering: "restart",
      mcp: true,
      effort: false,
      subagents: true,
    };
  }

  startTurn(ctx: TurnContext): TurnHandle {
    if (ctx.abortSignal?.aborted) {
      return preAbortedHandle();
    }

    const backendOptions = (ctx.backendOptions ?? {}) as OpenFxBackendOptions;
    const permissionHandler: PermissionHandler =
      backendOptions.onApprovalRequest ??
      this.config.permissionHandler ??
      denyPermissionHandler;

    const client = new AcpClient({
      cwd: ctx.cwd,
      executable: this.config.executable,
      extraArgs: this.config.extraArgs,
      env: this.config.env,
      model: backendOptions.model,
      closeTimeoutsMs: this.config.closeTimeoutsMs,
    });
    client.onPermissionRequest(permissionHandler);

    const mapper = new AcpChunkMapper();
    let sessionId: string | undefined;
    let steerText: string | undefined;
    let cancelledByUs = false;

    function cancelAndClose(): void {
      cancelledByUs = true;
      if (sessionId) {
        client.cancel(sessionId);
      }
      // If no session exists yet, there's nothing for session/cancel to
      // target (PROTOCOL.md §3: it "cancels whatever session is active").
      // orchestrate() below resends the cancel itself once a session (and
      // then a prompt) exists, instead of tearing the connection down here
      // and stranding session/new before it can hand back a sessionId to
      // use as resumeToken.
    }

    const onOuterAbort = () => cancelAndClose();
    ctx.abortSignal?.addEventListener("abort", onOuterAbort, { once: true });

    function buildSteeredResult(text: string): TurnResult {
      return {
        finishReason: "stop",
        isError: false,
        usage: zeroUsage(),
        ...(sessionId ? { resumeToken: sessionId } : {}),
        steered: { text },
      };
    }

    // Settled by orchestrate() with the turn's outcome; chunksGen() below
    // reads it (via `.then`, never awaiting it directly) purely to know
    // when to stop draining `client.updates`.
    const stopReasonDeferred = Promise.withResolvers<StopReason>();
    stopReasonDeferred.promise.catch(() => undefined);

    // Resolved by chunksGen()'s normal-completion path only (never on
    // abandonment/interrupt/steer, which settle `result` through the
    // `abandonment` race instead — see its own comment below). Exists so
    // `transportResult`'s normal-completion branch can wait on it: without
    // this, `result` would settle as soon as the underlying ACP turn
    // finishes, regardless of whether the caller has ever looked at
    // `chunks` — a direct violation of interface.ts's CONTRACT ("result
    // settles only after chunks is fully consumed"). The orchestration
    // (initialize/session/prompt) itself still runs eagerly and
    // independently of chunks consumption — only the value exposed via
    // `result` is gated.
    const chunksDrained = Promise.withResolvers<undefined>();
    chunksDrained.promise.catch(() => undefined);

    async function orchestrate(): Promise<void> {
      try {
        await client.initialize(INITIALIZE_PARAMS);

        if (ctx.resumeToken) {
          sessionId = ctx.resumeToken;
          await client.loadSession({
            sessionId: ctx.resumeToken,
            mcpServers: backendOptions.mcpServers,
          });
        } else {
          const session = await client.newSession({
            mcpServers: backendOptions.mcpServers,
          });
          sessionId = session.sessionId;
        }

        if (cancelledByUs) {
          // A steer/interrupt arrived before a session existed to target —
          // send it now that one does, rather than losing it entirely.
          client.cancel(sessionId);
        }

        const promptPromise = client.prompt({
          sessionId,
          prompt: [{ type: "text", text: ctx.prompt }],
        });
        if (cancelledByUs) {
          // Covers both the narrow window between the check above and this
          // request going out, and the "no session yet" case from
          // cancelAndClose()'s own comment: session/cancel sent before
          // session/prompt starts is silently reset the moment the prompt
          // begins (PROTOCOL.md §3; confirmed against the stub's
          // `handlePrompt`), so resending it immediately after — guaranteed
          // ordered after on the same stdio stream — is what actually
          // lands.
          client.cancel(sessionId);
        }
        const promptResult = await promptPromise;
        stopReasonDeferred.resolve(promptResult.stopReason);
      } catch (error) {
        stopReasonDeferred.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      } finally {
        // One AcpClient per turn (PROTOCOL.md §1) — always torn down here,
        // whatever the outcome (the amended CONTRACT's abandonment
        // finally-guard, generalized to every exit path, not just
        // abandonment).
        await client.close();
      }
    }

    void orchestrate();

    // Settled from chunksGen()'s `finally` if the caller abandons `chunks`
    // before the turn ends — the CONTRACT (interface.ts) treats that as
    // equivalent to interrupt().
    const abandonment = Promise.withResolvers<TurnResult>();
    abandonment.promise.catch(() => undefined);

    const transportResult: Promise<TurnResult> =
      stopReasonDeferred.promise.then(
        async (stopReason): Promise<TurnResult> => {
          // `cancelledByUs` is checked here too, not just below: a steer/
          // interrupt whose session/cancel arrived too late to actually stop
          // the scripted/real turn must still report AbortError/steered per
          // the CONTRACT, even though the transport itself reports a normal
          // completion. This branch (like the rejection branch below) keeps
          // its existing AbortError/steered semantics and does NOT wait on
          // `chunksDrained` — abandonment already has its own settlement
          // path (the `abandonment` race below), and steer/interrupt are
          // defined to resolve/reject `result` on their own, independent of
          // chunk consumption.
          if (stopReason === "cancelled" || cancelledByUs) {
            if (steerText !== undefined) {
              return buildSteeredResult(steerText);
            }
            throw abortError();
          }
          // Normal completion: the CONTRACT (interface.ts) requires
          // `result` to settle only once the caller has fully drained
          // `chunks`, so wait for chunksGen()'s own normal-completion
          // signal before producing a value.
          await chunksDrained.promise;
          return {
            finishReason: toFinishReason(stopReason),
            isError: stopReason === "refused",
            usage: zeroUsage(),
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
        const iterator = client.updates[Symbol.asyncIterator]();
        const donePromise: Promise<"done"> = stopReasonDeferred.promise.then(
          () => "done",
          () => "done",
        );
        for (;;) {
          const winner: UpdateRaceOutcome = await Promise.race([
            iterator
              .next()
              .then((r): UpdateRaceOutcome => ({ kind: "update", result: r })),
            donePromise.then((kind): UpdateRaceOutcome => ({ kind })),
          ]);
          if (winner.kind === "done" || winner.result.done) {
            break;
          }
          for (const chunk of mapper.map(winner.result.value.update)) {
            yield chunk;
          }
        }
        for (const chunk of mapper.finish()) {
          yield chunk;
        }
        completed = true;
        chunksDrained.resolve(undefined);
      } finally {
        // A consumer that abandons `chunks` early (break/return/throw on
        // the iterator) resumes this generator at this `finally` without
        // `completed` ever having been set. Per the CONTRACT, that is
        // equivalent to interrupt(): make sure `result` still settles
        // (rather than dangling) and the process actually gets torn down.
        if (!completed) {
          // Close out the mapper's own state (e.g. an open text block) even
          // though its output is discarded here — the turn is being
          // abandoned, not gracefully finished, so nothing should be
          // yielded from a `finally` mid-forced-return, but a mapper that
          // might be inspected or reused later should never be left
          // thinking a block is still open.
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
