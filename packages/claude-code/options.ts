/**
 * Model tier used to route work.
 *
 * Aliases resolve to the current model in that tier, so the platform doesn't
 * have to chase model-id changes.
 */
export type ModelTier =
  | "opus"
  | "sonnet"
  | "haiku"
  // Allows any full model id (e.g. "claude-opus-4-8") while keeping
  // autocomplete for the aliases above.
  // oxlint-disable-next-line ban-types
  | (string & {});

/**
 * A custom subagent definition, passed through to `claude --agents`.
 *
 * This is the tiering mechanism: the orchestrator runs on the main `model`
 * while each subagent can pin its own cheaper/faster model.
 */
export interface ClaudeAgentDefinition {
  /** Natural-language description of when to use this agent. */
  description: string;
  /** The agent's system prompt. */
  prompt: string;
  /** Model alias or full id. Omit to inherit the main model. */
  model?: ModelTier;
  /** Allowed tool names. Omit to inherit every tool from the parent. */
  tools?: string[];
  /** Explicitly denied tool names. */
  disallowedTools?: string[];
  /** Reasoning effort for this agent. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Maximum agentic turns before the subagent stops. */
  maxTurns?: number;
}

export type PermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "manual"
  | "dontAsk"
  | "plan";

export interface ClaudeCodeOptions {
  /** Working directory. Must be the host path of the sandbox workspace. */
  cwd: string;
  /** Main/orchestrator model. */
  model?: ModelTier;
  /** Fallback models tried in order when the main model is unavailable. */
  fallbackModels?: string[];
  /** Reasoning effort for the main session. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Custom subagents, keyed by name. */
  agents?: Record<string, ClaudeAgentDefinition>;
  /** Appended to the default system prompt. */
  appendSystemPrompt?: string;
  /** Replaces the default system prompt entirely. */
  systemPrompt?: string;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Restrict the built-in tool set. */
  tools?: string[];
  maxTurns?: number;
  /** Resume a previous session by id. */
  resume?: string;
  /** Force a specific session id for this run. */
  sessionId?: string;
  /** Emit token-level deltas as `stream_event` messages. */
  includePartialMessages?: boolean;
  /** Emit subagent text/thinking, not just their tool calls. */
  forwardSubagentText?: boolean;
  /** JSON Schema for structured output. */
  jsonSchema?: Record<string, unknown>;
  /** Extra environment variables for the CLI process. */
  env?: Record<string, string>;
  /** Path to the `claude` executable. Defaults to `claude` on PATH. */
  executable?: string;
  /**
   * Load host configuration (user/project settings, MCP servers, plugins,
   * skills). Defaults to `false` for reproducibility — see {@link buildArgs}.
   */
  inheritHostConfig?: boolean;
  /**
   * Extra settings, passed inline rather than through a file.
   *
   * This is how the tool-approval hook is installed. It has to be inline: the
   * alternative is writing `.claude/settings.json` into the workspace, which
   * would put Paco's configuration inside the user's repository and show up in
   * their diff. Passing JSON on the command line also means it composes with
   * `--setting-sources ""` — Paco's hook runs, and a `.claude/settings.json`
   * that arrived with a cloned repository still does not.
   */
  settings?: Record<string, unknown>;

  /**
   * MCP servers to expose to this session, keyed by server name, passed
   * inline via `--mcp-config` rather than a file — same rationale as
   * {@link settings}: nothing about a chat's configuration should be written
   * into the user's repository.
   *
   * `--strict-mcp-config` (see {@link buildArgs}) is what makes this safe to
   * add: only servers named here reach the session, never anything already
   * configured on the host.
   */
  mcpServers?: Record<
    string,
    { command: string; args: string[]; env: Record<string, string> }
  >;

  /**
   * Keep the CLI's built-in slash commands available.
   *
   * Normal turns disable them, which also disables `/compact` — the CLI
   * answers "/compact isn't available in this environment". Compaction is a
   * session-level operation rather than a turn, so it runs as its own
   * invocation with this set, and every ordinary turn stays as isolated as
   * before.
   */
  allowSlashCommands?: boolean;
}

/**
 * Build the argv for a headless Claude Code run.
 *
 * Isolation note: by default this passes `--setting-sources ""`,
 * `--strict-mcp-config`, and `--disable-slash-commands`. Without them a
 * `claude -p` run inherits whatever is configured on the host — personal MCP
 * servers, plugins, and skills all leak into the session and make runs
 * unreproducible across machines.
 *
 * `--bare` would be the documented way to get this isolation, but it also
 * disables OAuth and keychain reads and requires `ANTHROPIC_API_KEY`. Since
 * this project authenticates with a Claude subscription, `--bare` is not
 * usable and the explicit flags above are the equivalent.
 */
export function buildArgs(options: ClaudeCodeOptions): string[] {
  const args: string[] = [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    // stream-json output requires --verbose.
    "--verbose",
  ];

  if (!options.inheritHostConfig) {
    args.push("--setting-sources", "", "--strict-mcp-config");
    if (!options.allowSlashCommands) {
      args.push("--disable-slash-commands");
    }
  }

  if (options.settings) {
    args.push("--settings", JSON.stringify(options.settings));
  }

  if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
    args.push(
      "--mcp-config",
      JSON.stringify({ mcpServers: options.mcpServers }),
    );
  }

  if (options.model) {
    args.push("--model", options.model);
  }

  if (options.fallbackModels?.length) {
    args.push("--fallback-model", options.fallbackModels.join(","));
  }

  if (options.effort) {
    args.push("--effort", options.effort);
  }

  if (options.agents && Object.keys(options.agents).length > 0) {
    args.push("--agents", JSON.stringify(options.agents));
  }

  if (options.systemPrompt) {
    args.push("--system-prompt", options.systemPrompt);
  }

  if (options.appendSystemPrompt) {
    args.push("--append-system-prompt", options.appendSystemPrompt);
  }

  if (options.permissionMode) {
    args.push("--permission-mode", options.permissionMode);
  }

  if (options.allowedTools?.length) {
    args.push("--allowedTools", options.allowedTools.join(","));
  }

  if (options.disallowedTools?.length) {
    args.push("--disallowedTools", options.disallowedTools.join(","));
  }

  if (options.tools?.length) {
    args.push("--tools", options.tools.join(","));
  }

  if (options.maxTurns !== undefined) {
    args.push("--max-turns", String(options.maxTurns));
  }

  if (options.resume) {
    args.push("--resume", options.resume);
  } else if (options.sessionId) {
    args.push("--session-id", options.sessionId);
  }

  if (options.includePartialMessages) {
    args.push("--include-partial-messages");
  }

  if (options.forwardSubagentText) {
    args.push("--forward-subagent-text");
  }

  if (options.jsonSchema) {
    args.push("--json-schema", JSON.stringify(options.jsonSchema));
  }

  return args;
}

/**
 * Subagent roster, tiered by the kind of work each does.
 *
 * The point of the tiers is that most tokens are spent on work that does not
 * need the strongest model. The main model orchestrates — it plans, researches,
 * and decides — and hands the mechanical parts down:
 *
 *   orchestrator  the chat's own model. Judgement, research, decisions.
 *   executor      Sonnet. Implements exactly what it was told to implement.
 *   explorer      Haiku. Looks things up. No judgement required.
 *
 * Per-agent, deliberately. A single "use this model for subagents" setting
 * flattens all of them onto one model, which removes the only thing tiering
 * does.
 */
export const DEFAULT_AGENTS: Record<string, ClaudeAgentDefinition> = {
  explorer: {
    description:
      "Read-only codebase exploration: tracing behavior, locating code, and answering questions without changing files.",
    prompt:
      "You are an explorer agent. Investigate the codebase and report findings concisely. Never modify files. Return file paths with line numbers so the caller can act on them directly. Do not evaluate, recommend, or decide anything — report what is there and let the caller judge it.",
    model: "haiku",
    tools: ["Read", "Grep", "Glob", "Bash"],
  },
  executor: {
    description:
      "Well-scoped implementation work: edits, scaffolding, refactors, and other file changes described precisely by the caller.",
    prompt:
      "You are an executor agent. Implement exactly what the caller specified and verify it. Do not expand scope, redesign, or substitute your own approach — if the instruction is ambiguous, implement the narrowest reading and say so. Report what changed and how you verified it.",
    model: "sonnet",
  },
};
