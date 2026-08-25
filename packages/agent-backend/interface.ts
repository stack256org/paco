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
