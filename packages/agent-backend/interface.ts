import type { UIMessageChunk } from "ai";
import type { TurnFinishReason, TurnUsage } from "./events.ts";

/**
 * What a backend supports, declared rather than assumed, so the UI and the
 * workflow adapt instead of breaking when a backend lacks a feature (spec 1b).
 */
export interface BackendCapabilities {
  /** Stable identifier, e.g. "claude-code", "openfx". */
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
   * Can the CALLER install its own subagent roster (Paco's Section 3
   * agents, with their per-agent model tiers)?
   *
   * Distinct from `subagents`, which only says the backend delegates at
   * all: OpenFX runs a roster of its own but its protocol carries no way
   * to define one, so it reports `subagents: true, customAgents: false`.
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
   * `undefined` means the app's own catalog applies unchanged (Claude
   * Code, whose tier aliases the catalog is written in). An EMPTY array
   * means the backend resolves its own model and takes none from the
   * picker — the honest answer for OpenFX, where `--model opus` would be a
   * Claude alias handed to a binary that has never heard of it, and where
   * the model comes from the binary's own config instead.
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
