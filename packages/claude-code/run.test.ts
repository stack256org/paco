import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runClaudeCode } from "./run.ts";

/**
 * What the fake `claude` reports back about how it was invoked.
 *
 * This is an end-to-end check on purpose. `buildArgs` and `agentProcessEnv`
 * are unit-tested on their own, but the two security properties this file
 * pins — a bearer token that never reaches argv, and a child that never
 * inherits Paco's secrets — are properties of the *spawn*, and only a real
 * spawn can prove them.
 */
interface Invocation {
  argv: string[];
  env: Record<string, string | undefined>;
  /** The `--mcp-config` file's content, as the child itself could read it. */
  mcpConfig: unknown;
}

const FAKE_CLI_SOURCE = `
const fs = require("node:fs");

const readMcpConfig = () => {
  const argv = process.argv.slice(2);
  const index = argv.indexOf("--mcp-config");
  if (index === -1) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(argv[index + 1], "utf-8"));
  } catch (error) {
    return { error: String(error) };
  }
};

let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
});
process.stdin.on("end", () => {
  const invocation = {
    argv: process.argv.slice(2),
    env: process.env,
    mcpConfig: readMcpConfig(),
  };
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1,
      num_turns: 1,
      session_id: "fake-session",
      uuid: "fake-uuid",
      result: JSON.stringify(invocation),
    }) + "\\n",
  );
});
`;

let fakeCliDir: string;
let fakeCli: string;

beforeAll(() => {
  fakeCliDir = mkdtempSync(join(tmpdir(), "paco-fake-claude-"));
  const script = join(fakeCliDir, "fake-claude.js");
  writeFileSync(script, FAKE_CLI_SOURCE, "utf-8");

  // A shell wrapper rather than a shebang: `runClaudeCode` spawns
  // `options.executable` with `buildArgs`'s argv and nothing else, so the
  // executable has to be a real program, and this test file may itself be
  // running under bun rather than node.
  fakeCli = join(fakeCliDir, "claude");
  writeFileSync(
    fakeCli,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
    { encoding: "utf-8", mode: 0o755 },
  );
});

const SAVED_ENV = { ...process.env };

afterAll(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED_ENV)) {
      delete process.env[key];
    }
  }
});

const PLUGIN_TOOLS_TOKEN = "plugin-tools-token-that-must-not-reach-argv";

const MCP_SERVERS = {
  "paco-plugins": {
    command: "/usr/bin/node",
    args: ["/home/paco/.paco/mcp/plugin-mcp-server.ts"],
    env: {
      PACO_INTERNAL_URL: "http://127.0.0.1:3000/api/internal/plugin-tools",
      PACO_INTERNAL_TOKEN: PLUGIN_TOOLS_TOKEN,
      PACO_PLUGIN_TOOLS: "[]",
    },
  },
};

async function invoke(
  options: Parameters<typeof runClaudeCode>[1],
): Promise<Invocation> {
  const run = runClaudeCode("hello", options);
  for await (const _message of run.messages) {
    // Drain: the terminal result only resolves once the stream is consumed.
  }
  const result = await run.result;
  return JSON.parse(result.result ?? "{}") as Invocation;
}

describe("runClaudeCode", () => {
  test("keeps the plugin-tools bearer token out of the process argv", async () => {
    const invocation = await invoke({
      cwd: fakeCliDir,
      executable: fakeCli,
      mcpServers: MCP_SERVERS,
    });

    // `ps auxww` shows one process's arguments to every account on the
    // machine. AGENTS.md states the rule for `gh`; it is the same rule here.
    expect(invocation.argv.join(" ")).not.toContain(PLUGIN_TOOLS_TOKEN);

    const index = invocation.argv.indexOf("--mcp-config");
    expect(index).toBeGreaterThan(-1);
    const configPath = invocation.argv[index + 1] as string;
    expect(configPath.startsWith("{")).toBe(false);

    // Read by the child itself, while it was running: proof the path is a
    // real file the CLI can load, not just a string that avoids `ps`.
    expect(invocation.mcpConfig).toEqual({ mcpServers: MCP_SERVERS });
  });

  test("removes the config file once the run is over", async () => {
    const run = runClaudeCode("hello", {
      cwd: fakeCliDir,
      executable: fakeCli,
      mcpServers: MCP_SERVERS,
    });
    for await (const _message of run.messages) {
      // Drain.
    }
    const invocation = JSON.parse(
      (await run.result).result ?? "{}",
    ) as Invocation;
    const configPath = invocation.argv[
      invocation.argv.indexOf("--mcp-config") + 1
    ] as string;

    await new Promise<void>((resolve) => {
      if (run.process.exitCode !== null || run.process.signalCode !== null) {
        setTimeout(resolve, 50);
        return;
      }
      run.process.once("close", () => setTimeout(resolve, 50));
    });

    expect(existsSync(configPath)).toBe(false);
  });

  test("does not hand Paco's own secrets to the agent", async () => {
    process.env.APP_SECRET = "the-session-signing-key";
    process.env.POSTGRES_URL = "postgres://paco:paco@localhost:5432/paco";
    process.env.SMTP_PASSWORD = "hunter2";
    process.env.PACO_APPROVAL_TOKEN = "ambient-approval-token";

    const invocation = await invoke({ cwd: fakeCliDir, executable: fakeCli });

    // Every one of these was readable by any command the agent chose to run,
    // because the CLI was spawned with `{...process.env}`.
    expect(invocation.env.APP_SECRET).toBeUndefined();
    expect(invocation.env.POSTGRES_URL).toBeUndefined();
    expect(invocation.env.SMTP_PASSWORD).toBeUndefined();
    expect(invocation.env.PACO_APPROVAL_TOKEN).toBeUndefined();
  });

  test("still gives the CLI what it needs to run and authenticate", async () => {
    const invocation = await invoke({ cwd: fakeCliDir, executable: fakeCli });

    expect(invocation.env.PATH).toBe(process.env.PATH);
    expect(invocation.env.HOME).toBe(process.env.HOME);
  });

  test("passes explicitly supplied env through, since that is the sanctioned route", async () => {
    process.env.APP_SECRET = "the-session-signing-key";

    const invocation = await invoke({
      cwd: fakeCliDir,
      executable: fakeCli,
      env: {
        PACO_APPROVAL_TOKEN: "deliberate-approval-token",
        GH_TOKEN: "gho_deliberate",
      },
    });

    expect(invocation.env.PACO_APPROVAL_TOKEN).toBe(
      "deliberate-approval-token",
    );
    expect(invocation.env.GH_TOKEN).toBe("gho_deliberate");
    expect(invocation.env.APP_SECRET).toBeUndefined();
  });
});
