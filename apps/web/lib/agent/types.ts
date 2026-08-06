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
}
