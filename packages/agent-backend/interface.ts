import type { UIMessageChunk } from "ai";
import type { TurnFinishReason, TurnUsage } from "./events.ts";

/**
 * What a backend supports, declared rather than assumed, so the UI and the
 * workflow adapt instead of breaking when a backend lacks a feature (spec 1b).
 */
export interface BackendCapabilities {
  /** Stable identifier, e.g. "claude-code", "poolside". */
  id: string;
  /** Can a later turn resume this backend's own conversation state? */
  resume: boolean;
  /** How steer() behaves: "restart" ends the turn carrying the steer text; "none" rejects. */
  steering: "restart" | "none";
  /** Does the backend accept MCP server configuration? */
  mcp: boolean;
  /** Does the backend accept a reasoning-effort setting? */
  effort: boolean;
  /** Does the backend run its own subagent roster? */
  subagents: boolean;
  /**
   * Can the backend's CONFIGURED MODEL actually accept image input?
   *
   * Not a protocol question, and that distinction is the whole reason this
   * field exists. ACP's `initialize` handshake answers
   * `promptCapabilities: {image: true}` for Poolside — the TRANSPORT will
   * carry an image content block — while every model behind it is blind.
   * Measured against `pool` 1.0.16, both shipped models, both delivery
   * paths:
   *
   * - An inline `{type: "image"}` block in `session/prompt` is accepted
   *   with `stopReason: "end_turn"` and NO error, and the model answers
   *   "IMAGE-NOT-VISIBLE" — a silent drop, on `poolside/laguna-s-2.1` and
   *   `poolside/laguna-xs-2.1` alike.
   * - The agent's own `Read` on a staged `.png` fails with "the configured
   *   model does not support image inputs", again on both models.
   *
   * So do NOT "fix" a `false` here by re-reading the handshake: the
   * handshake is what makes the failure silent. Change it only when a live
   * turn on that backend reports the colour of a solid-colour PNG without
   * shelling out to Python.
   *
   * Required rather than optional on purpose. The other soft capabilities
   * below let `undefined` mean "yes" for backends written before they
   * existed; that default is exactly what hid this one for a release, so
   * every backend has to answer in writing.
   */
  images: boolean;
  /**
   * Can the CALLER ask this backend to compact the conversation on demand?
   *
   * A context-usage readout is only a button if something can act on it.
   * Claude Code answers yes: `/compact` is a real command, and
   * `compactSession` drives it.
   *
   * Poolside answers no, and the distinction is the same one `images` draws
   * — a capability the handshake advertises is not the same as a capability
   * the caller can invoke. `pool` 1.0.16 declares
   * `poolside/compaction_update: true`, which says the AGENT compacts and
   * tells the client afterwards; it does not put compaction under the
   * client's control. Probed against the live binary: `session/compact`,
   * `session/summarize` and `poolside/compact` all answer
   * `-32601 Method not found`, `availableCommands` is null (so there is no
   * slash command either), and the four session config options are `mode`,
   * `agent_mode`, `thought_level` and `model` — none of them compaction.
   *
   * So a compact control on a Poolside chat has nothing to call. Offering
   * one anyway is what this field prevents: the button used to render for
   * every backend and POST to a Claude-only route, which answered a
   * Poolside chat with "this chat has not run a turn yet" — an error about
   * the wrong thing entirely.
   *
   * Required, not optional, for `images`' reason: a default of "yes" is
   * exactly how a control ends up offered for a backend that cannot serve
   * it.
   */
  compaction: boolean;
  /**
   * Can the CALLER install its own subagent roster (Paco's Section 3
   * agents, with their per-agent model tiers)?
   *
   * Distinct from `subagents`, which only says the backend delegates at
   * all: Poolside runs a roster of its own — its usage `_meta` reports
   * `poolside/subagentTotals` — but the only handle its protocol offers,
   * `_meta["poolside/session_agent_config"]`, SELECTS an agent that is
   * already defined rather than defining one. So it reports
   * `subagents: true, customAgents: false`.
   *
   * Optional, and `undefined` means "yes" — the assumption every backend
   * written before this field existed was built on, and the one
   * `ClaudeCodeBackend` still satisfies. A backend that cannot must say
   * `false` explicitly; that is what stops a caller's roster from being
   * dropped without a trace.
   */
  customAgents?: boolean;
  /**
   * Can a turn's output be constrained by a JSON Schema (the planner's and
   * the reviewer's shaped answers)?
   *
   * `undefined` means yes, as with `customAgents`. A backend reporting
   * `false` returns free text no matter what schema it is handed, so a
   * caller that needs structure must check this rather than discover it as
   * an `undefined` result.
   */
  structuredOutput?: boolean;
  /**
   * The model ids this backend accepts from Paco's picker.
   *
   * Three distinct answers, and the difference between the last two is
   * what callers get wrong:
   *
   * - `undefined` — the app's own catalog applies unchanged (Claude Code,
   *   whose tier aliases the catalog is written in).
   * - A NON-EMPTY array — a narrowing, not a loss. The picker still
   *   applies; it just offers these ids. Poolside reports its two
   *   `poolside/laguna-*` ids, read off a live `session/new`'s `model`
   *   config option. They are not Claude tier aliases, which is the whole
   *   reason the list has to be declared: handing `opus` to a backend that
   *   has never heard of it is the failure this field prevents.
   * - An EMPTY array — the backend resolves its own model and takes none
   *   from the picker, so the control has nothing to show and is hidden.
   *   No shipped backend answers this way today; it stays because "I
   *   choose my own model" is a real thing for a backend to say, and the
   *   UI must not read it as "every model is allowed".
   */
  models?: readonly string[];
}

export interface TurnContext {
  /** Host working directory for the turn (a chat's worktree). */
  cwd: string;
  /** The user prompt for this turn. */
  prompt: string;
  /** Resume token from a prior turn's TurnResult, when capabilities().resume. */
  resumeToken?: string;
  /** Cooperative cancellation for the whole turn. */
  abortSignal?: AbortSignal;
  /**
   * Backend-specific options bag. Each implementation documents and narrows
   * its own shape; the neutral interface does not interpret it.
   */
  backendOptions?: unknown;
}

export interface TurnResult {
  finishReason: TurnFinishReason;
  isError: boolean;
  usage: TurnUsage;
  costUsd?: number;
  /** Token to pass as the next turn's resumeToken, when supported. */
  resumeToken?: string;
  /** Set when the turn ended because steer() was called; carries the steer text. */
  steered?: { text: string };
  /**
   * Parsed structured output, when the turn was constrained by a JSON
   * Schema. Backend-specific in origin (Claude Code's terminal `result`
   * message carries it as `structured_output`); the neutral interface only
   * forwards it.
   */
  structuredOutput?: unknown;
}

export class SteeringUnsupportedError extends Error {
  constructor(backendId: string) {
    super(`Backend "${backendId}" does not support steering`);
    this.name = "SteeringUnsupportedError";
  }
}

/**
 * One running turn.
 *
 * Contract (enforced by the conformance suite):
 * - `chunks` yields zero or more UI chunks, then ends; `result` settles only
 *   after `chunks` is fully consumed.
 * - `interrupt()` aborts the turn: `result` REJECTS with an error whose
 *   `name` is "AbortError".
 * - `steer(text)` with steering "restart": the turn winds down and `result`
 *   RESOLVES with `steered: { text }` and `isError: false`. With steering
 *   "none": `steer` rejects with SteeringUnsupportedError and the turn
 *   continues unaffected.
 * - Abandoning `chunks` before the turn ends is equivalent to `interrupt()`:
 *   `result` rejects with an AbortError.
 */
export interface TurnHandle {
  chunks: AsyncIterable<UIMessageChunk>;
  result: Promise<TurnResult>;
  steer(text: string): Promise<void>;
  interrupt(): void;
}

export interface AgentBackend {
  capabilities(): BackendCapabilities;
  startTurn(ctx: TurnContext): TurnHandle;
}
