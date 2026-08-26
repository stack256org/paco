import { z } from "zod";

/**
 * Zod mirror of `ClaudeAgentDefinition` (`@paco/claude-code`).
 *
 * A roster row's `definition` column is untyped JSONB — it can arrive as
 * `unknown` from `upsertRosterAgent`'s caller, or as a value nothing has
 * validated since it was written, from a database read. This schema is what
 * stands between that blob and `--agents`: `.strict()` rejects unknown keys
 * instead of dropping them silently, so a typo'd field surfaces as a
 * rejected write rather than agent behavior configured out from under it.
 *
 * Keep this in sync with `ClaudeAgentDefinition` field-for-field; there is no
 * mechanism that enforces the two stay identical.
 */
export const agentDefinitionSchema = z
  .object({
    /** Natural-language description of when to use this agent. */
    description: z.string(),
    /** The agent's system prompt. */
    prompt: z.string(),
    /** Model alias or full id. Omit to inherit the main model. */
    model: z.string().optional(),
    /** Allowed tool names. Omit to inherit every tool from the parent. */
    tools: z.array(z.string()).optional(),
    /** Explicitly denied tool names. */
    disallowedTools: z.array(z.string()).optional(),
    /** Reasoning effort for this agent. */
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    /** Maximum agentic turns before the subagent stops. */
    maxTurns: z.number().optional(),
  })
  .strict();

/**
 * The validated shape of a roster agent's `definition` column.
 *
 * Structurally identical to `ClaudeAgentDefinition` (`model` is typed as
 * `string` here rather than the `ModelTier` alias, which is itself just a
 * string with extra autocomplete hints — the two widen to the same thing).
 */
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
