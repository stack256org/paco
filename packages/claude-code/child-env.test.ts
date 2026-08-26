import { describe, expect, test } from "bun:test";
import { agentProcessEnv } from "./child-env.ts";

/**
 * A realistic Paco server environment: everything `apps/web/.env.example`
 * asks an operator to set, plus the values Paco assigns itself, plus the
 * handful of things the CLI genuinely needs.
 */
function serverEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/paco",
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
    APP_SECRET: "the-session-signing-key",
    APP_URL: "https://paco.example",
    POSTGRES_URL: "postgres://paco:paco@localhost:5432/paco",
    SMTP_PASSWORD: "hunter2",
    SMTP_USER: "paco@example.com",
    PACO_APPROVAL_TOKEN: "approval-bearer-token",
    PACO_INTERNAL_TOKEN: "plugin-tools-bearer-token",
    PACO_WORKSPACE_ROOT: "/Users/paco/.paco/workspaces",
    WORKFLOW_POSTGRES_URL: "postgres://paco:paco@localhost:5432/paco",
    ...overrides,
  };
}

describe("agentProcessEnv", () => {
  test("keeps nothing it was not explicitly asked to keep", () => {
    const env = agentProcessEnv(serverEnv());

    // Everything Paco stores its own secrets in. `run.ts` used to hand the
    // CLI `{...process.env}`, which made every one of these readable by any
    // command the agent chose to run.
    expect(env.APP_SECRET).toBeUndefined();
    expect(env.POSTGRES_URL).toBeUndefined();
    expect(env.WORKFLOW_POSTGRES_URL).toBeUndefined();
    expect(env.SMTP_PASSWORD).toBeUndefined();
    expect(env.SMTP_USER).toBeUndefined();
    expect(env.APP_URL).toBeUndefined();
  });

  test("drops Paco's own bearer tokens, which reach the CLI explicitly or not at all", () => {
    const env = agentProcessEnv(serverEnv());

    // `PACO_APPROVAL_TOKEN` is passed deliberately through
    // `ClaudeCodeOptions.env` for the turns that need it; inheriting it
    // ambiently means every OTHER turn's Bash tool can read it too.
    expect(env.PACO_APPROVAL_TOKEN).toBeUndefined();
    expect(env.PACO_INTERNAL_TOKEN).toBeUndefined();
    expect(env.PACO_WORKSPACE_ROOT).toBeUndefined();
  });

  test("keeps what the CLI cannot start without", () => {
    const env = agentProcessEnv(serverEnv());

    // PATH finds `claude`, `git` and `rg`; HOME is where the subscription
    // login lives (`~/.claude/.credentials.json`, or the keychain reached
    // through it). Dropping either is a CLI that cannot run or cannot auth.
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/Users/paco");
    expect(env.SHELL).toBe("/bin/zsh");
    expect(env.LANG).toBe("en_US.UTF-8");
  });

  test("keeps the CLI's own configuration and credentials", () => {
    const env = agentProcessEnv(
      serverEnv({
        ANTHROPIC_API_KEY: "sk-ant-test",
        ANTHROPIC_BASE_URL: "https://proxy.example",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-test",
        CLAUDE_CONFIG_DIR: "/Users/paco/.claude",
        MAX_THINKING_TOKENS: "20000",
        DISABLE_AUTOUPDATER: "1",
        MCP_TIMEOUT: "30000",
      }),
    );

    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://proxy.example");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-test");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/Users/paco/.claude");
    expect(env.MAX_THINKING_TOKENS).toBe("20000");
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
    expect(env.MCP_TIMEOUT).toBe("30000");
  });

  test("keeps proxy and private-CA settings, which a self-hosted instance needs to reach the API", () => {
    const env = agentProcessEnv(
      serverEnv({
        HTTPS_PROXY: "http://corp-proxy:3128",
        https_proxy: "http://corp-proxy:3128",
        NO_PROXY: "localhost",
        NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
      }),
    );

    expect(env.HTTPS_PROXY).toBe("http://corp-proxy:3128");
    expect(env.https_proxy).toBe("http://corp-proxy:3128");
    expect(env.NO_PROXY).toBe("localhost");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/corp.pem");
  });

  test("never passes NODE_OPTIONS, which is arbitrary code execution in the CLI's own process", () => {
    const env = agentProcessEnv(
      serverEnv({ NODE_OPTIONS: "--require /tmp/evil.js" }),
    );

    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  test("passes cloud provider credentials only when the CLI is pointed at that provider", () => {
    const withoutBedrock = agentProcessEnv(
      serverEnv({
        AWS_ACCESS_KEY_ID: "AKIA",
        AWS_SECRET_ACCESS_KEY: "shh",
      }),
    );
    expect(withoutBedrock.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(withoutBedrock.AWS_SECRET_ACCESS_KEY).toBeUndefined();

    const withBedrock = agentProcessEnv(
      serverEnv({
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_ACCESS_KEY_ID: "AKIA",
        AWS_SECRET_ACCESS_KEY: "shh",
      }),
    );
    expect(withBedrock.AWS_ACCESS_KEY_ID).toBe("AKIA");
    expect(withBedrock.AWS_SECRET_ACCESS_KEY).toBe("shh");

    const withVertex = agentProcessEnv(
      serverEnv({
        CLAUDE_CODE_USE_VERTEX: "1",
        GOOGLE_APPLICATION_CREDENTIALS: "/creds.json",
        CLOUDSDK_CORE_PROJECT: "proj",
      }),
    );
    expect(withVertex.GOOGLE_APPLICATION_CREDENTIALS).toBe("/creds.json");
    expect(withVertex.CLOUDSDK_CORE_PROJECT).toBe("proj");
  });

  test("drops variables with no value rather than passing an empty string", () => {
    const env = agentProcessEnv({ PATH: undefined, HOME: "/Users/paco" });

    expect("PATH" in env).toBe(false);
    expect(env.HOME).toBe("/Users/paco");
  });
});
