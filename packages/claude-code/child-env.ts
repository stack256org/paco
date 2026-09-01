/**
 * The environment the `claude` CLI is spawned with.
 *
 * `run.ts` used to spawn the CLI with `{...process.env, ...options.env}`.
 * That handed the agent Paco's entire server environment — `APP_SECRET`
 * (which derives the key that encrypts the stored GitHub token),
 * `POSTGRES_URL`, `SMTP_PASSWORD`, `PACO_APPROVAL_TOKEN` — and the
 * agent has a `Bash` tool, so every one of those was one `env` away from
 * being read, printed into a transcript, or exfiltrated by anything the
 * agent was persuaded to run. Anything the CLI spawns in turn (an MCP stdio
 * server, a `PreToolUse` hook, a `Bash` command) inherits the same set.
 *
 * `PluginHost` already solves this for plugin workers by building their
 * environment from scratch — see `packages/plugin-host/SECURITY.md`, "No
 * ambient secrets": *"The worker's environment is constructed from scratch,
 * not filtered from the host's… There is no denylist to get wrong."* This is
 * the same construction for the agent, which cannot be quite as bare: the CLI
 * has to find its binaries, read its own credentials, and get out through
 * whatever proxy the instance sits behind.
 *
 * **This is an allowlist and must stay one.** SECURITY.md's own lesson —
 * three adversarial reviews, three escapes, all of them a denylist against a
 * surface larger than the list — applies exactly as well to environment
 * variables: a denylist would have to be updated every time Paco (or one of
 * its dependencies) starts reading a new one, and the failure mode is silent.
 * Anything not named here does not reach the agent. A caller that genuinely
 * needs to pass something does it explicitly through
 * `ClaudeCodeOptions.env`, which is spread over this result — that is how
 * `PACO_APPROVAL_TOKEN` and `GH_TOKEN` reach the turns that need them
 * (`apps/web/lib/agent/run-step.ts`), and it keeps "this turn can read that
 * token" a decision someone made rather than an accident of inheritance.
 */

/**
 * Names the CLI, or a tool it runs, cannot work without.
 *
 * Verified against what the CLI actually does rather than guessed at:
 * `apps/web/.env.example` records that Paco authenticates the agent with
 * `claude auth login` and a subscription — no API key — so the credentials
 * live under `HOME` (`~/.claude/.credentials.json`, or the OS keychain
 * reached through it). Without `HOME` the CLI cannot authenticate at all;
 * without `PATH` it cannot find `git`, `rg`, or the `node` an MCP stdio
 * server is spawned with.
 */
const ALLOWED_NAMES: ReadonlySet<string> = new Set([
  // Process basics.
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  // Locale and terminal: output encoding and formatting for the tools the
  // agent runs. A missing LANG turns non-ASCII output into mojibake.
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  // Where the CLI keeps its own configuration and cache.
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  // Egress. A self-hosted instance behind a corporate proxy or a private CA
  // cannot reach the API without these, and the failure looks like a broken
  // agent rather than a missing variable.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // Documented Claude Code settings that carry no CLAUDE_/ANTHROPIC_ prefix.
  "BASH_DEFAULT_TIMEOUT_MS",
  "BASH_MAX_TIMEOUT_MS",
  "BASH_MAX_OUTPUT_LENGTH",
  "MAX_THINKING_TOKENS",
  "MAX_MCP_OUTPUT_TOKENS",
  "MCP_TIMEOUT",
  "MCP_TOOL_TIMEOUT",
  "USE_BUILTIN_RIPGREP",
  "DISABLE_AUTOUPDATER",
  "DISABLE_TELEMETRY",
  "DISABLE_ERROR_REPORTING",
  "DISABLE_BUG_COMMAND",
  "DISABLE_COST_WARNINGS",
  "DISABLE_NON_ESSENTIAL_MODEL_CALLS",
  "DISABLE_INTERLEAVED_THINKING",
]);

/**
 * Prefixes covering the CLI's own configuration and credentials.
 *
 * `ANTHROPIC_*` and `CLAUDE_*` are the CLI's namespace — API key, OAuth
 * token, base URL, config directory, model overrides, feature flags — and
 * new ones appear with releases, which is exactly the case a prefix handles
 * and an exhaustive list does not. `OTEL_*` is the CLI's telemetry
 * configuration, which an operator sets on the server process expecting it
 * to apply.
 *
 * Paco's own `PACO_*` namespace is deliberately absent: those are this
 * server's secrets (`PACO_APPROVAL_TOKEN`) and its deployment layout
 * (`PACO_WORKSPACE_ROOT`), and the ones a turn needs are passed explicitly.
 */
const ALLOWED_PREFIXES: readonly string[] = [
  "ANTHROPIC_",
  "CLAUDE_",
  "OTEL_",
  "VERTEX_REGION_",
];

/**
 * Third-party model-provider credentials, passed only when the CLI has
 * actually been pointed at that provider.
 *
 * `AWS_*` and `GOOGLE_*`/`CLOUDSDK_*` are how Bedrock and Vertex
 * deployments authenticate, so a blanket refusal would break them — but on
 * an ordinary subscription install those same names are just the operator's
 * unrelated cloud credentials, and handing them to the agent is the leak
 * this file exists to stop. Gating each set on the flag that selects the
 * provider passes them exactly where they are needed and nowhere else.
 */
const PROVIDER_PREFIXES: ReadonlyArray<{
  readonly flag: string;
  readonly prefixes: readonly string[];
}> = [
  { flag: "CLAUDE_CODE_USE_BEDROCK", prefixes: ["AWS_"] },
  { flag: "CLAUDE_CODE_USE_VERTEX", prefixes: ["GOOGLE_", "CLOUDSDK_"] },
];

function allowedPrefixesFor(
  source: Record<string, string | undefined>,
): readonly string[] {
  const prefixes = [...ALLOWED_PREFIXES];
  for (const provider of PROVIDER_PREFIXES) {
    if (source[provider.flag]) {
      prefixes.push(...provider.prefixes);
    }
  }
  return prefixes;
}

/**
 * Builds the CLI's environment from `source` (normally `process.env`),
 * keeping only what is named above.
 *
 * Variables with no value are dropped rather than passed as `""`: an empty
 * `HTTPS_PROXY` is not the same as an absent one to most HTTP clients.
 */
export function agentProcessEnv(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const prefixes = allowedPrefixesFor(source);
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    const allowed =
      ALLOWED_NAMES.has(key) ||
      prefixes.some((prefix) => key.startsWith(prefix));
    if (allowed) {
      env[key] = value;
    }
  }

  return env;
}
