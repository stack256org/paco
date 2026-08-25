import type { ClaudeAgentDefinition, ModelTier } from "@paco/claude-code";
import type { SandboxState, SkillMetadata } from "@paco/sandbox";

/** A model choice, optionally with an effort override. */
export interface AgentModelSelection {
  /** Model alias (`opus`/`sonnet`/`haiku`) or a full Claude model id. */
  id: ModelTier;
  /** Reasoning effort for this selection. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

/** Sandbox context handed to the agent for a run. */
interface AgentSandboxContext {
  state: SandboxState;
  /** Working directory as the agent sees it. */
  workingDirectory: string;
  /**
   * Host directory the agent process is started in — the chat's worktree.
   *
   * Distinct from `workingDirectory`, which is the container-side path. The
   * agent runs on the host, so this is the one that decides which branch its
   * edits land on.
   */
  hostWorkingDirectory?: string;
  currentBranch?: string;
  environmentDetails?: string;
}

/**
 * Options for one agent turn.
 *
 * `model` drives the orchestrator;
 * `agents` carries the tiered subagent roster.
 */
export interface AgentCallOptions {
  sandbox: AgentSandboxContext;
  /** Orchestrator model. */
  model?: AgentModelSelection;
  /** Default model for delegated subagents. */
  /** Custom subagent roster. Falls back to the tiered defaults. */
  agents?: Record<string, ClaudeAgentDefinition>;
  /** Extra system-prompt guidance (project instructions). */
  customInstructions?: string;
  /** Skills discovered in the sandbox workspace. */
  skills?: SkillMetadata[];
  /**
   * Rendered "## Memory" section for this turn (see
   * `lib/memory/load-for-turn.ts`), threaded straight through to
   * `buildAppendSystemPrompt`. Loaded fresh per turn, so it is absent
   * whenever nothing scored above zero or the load failed.
   */
  memorySection?: string;
  /**
   * JSON Schema constraining this turn's output (`--json-schema`).
   *
   * The turn's parsed result is read back from
   * `AgentStepResult.structuredOutput` once it settles. Used by headless
   * callers (e.g. the planner) that need a shaped answer rather than free
   * text.
   */
  structuredOutput?: { jsonSchema: Record<string, unknown> };
  /**
   * Restricts the built-in tool set available to the turn (`--tools`).
   *
   * Omit to inherit every tool. Used to give a headless turn read-only
   * exploration (e.g. `["Read", "Grep", "Glob", "Bash"]`) without also
   * granting it edit tools.
   */
  tools?: string[];
}
