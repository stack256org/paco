import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { cleanupMcpConfigFile } from "./mcp-config-file.ts";
import { buildArgs, DEFAULT_AGENTS } from "./options.ts";

describe("buildArgs", () => {
  test("emits the headless stream-json protocol flags", () => {
    const args = buildArgs({ cwd: "/tmp/ws" });

    expect(args).toContain("-p");
    expect(args.join(" ")).toContain("--output-format stream-json");
    expect(args.join(" ")).toContain("--input-format stream-json");
    // stream-json output is rejected by the CLI without --verbose.
    expect(args).toContain("--verbose");
  });

  test("isolates from host config by default", () => {
    const args = buildArgs({ cwd: "/tmp/ws" });

    // Without these, a run inherits the host's MCP servers, plugins, and
    // skills, which makes results differ per machine.
    expect(args).toContain("--setting-sources");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--disable-slash-commands");
  });

  test("does not pass --bare, which would disable OAuth", () => {
    // --bare forces ANTHROPIC_API_KEY auth; this project uses subscription
    // OAuth, so it must never be added.
    expect(buildArgs({ cwd: "/tmp/ws" })).not.toContain("--bare");
  });

  test("opts back into host config when asked", () => {
    const args = buildArgs({ cwd: "/tmp/ws", inheritHostConfig: true });

    expect(args).not.toContain("--setting-sources");
    expect(args).not.toContain("--strict-mcp-config");
  });

  test("serializes custom agents as JSON", () => {
    const args = buildArgs({ cwd: "/tmp/ws", agents: DEFAULT_AGENTS });
    const index = args.indexOf("--agents");

    expect(index).toBeGreaterThan(-1);

    const parsed = JSON.parse(args[index + 1] as string);
    expect(parsed.explorer.model).toBe("haiku");
    expect(parsed.executor.model).toBe("sonnet");
  });

  test("prefers --resume over --session-id when both are given", () => {
    const args = buildArgs({
      cwd: "/tmp/ws",
      resume: "session-a",
      sessionId: "session-b",
    });

    expect(args).toContain("--resume");
    expect(args).not.toContain("--session-id");
  });

  test("joins fallback models into a single comma-separated flag", () => {
    const args = buildArgs({
      cwd: "/tmp/ws",
      fallbackModels: ["sonnet", "haiku"],
    });

    expect(args[args.indexOf("--fallback-model") + 1]).toBe("sonnet,haiku");
  });

  test("omits --mcp-config when no mcpServers are given", () => {
    const args = buildArgs({ cwd: "/tmp/ws" });

    expect(args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--disable-slash-commands",
    ]);
  });

  test("emits --mcp-config as a private file path, never inline JSON, and keeps --strict-mcp-config", () => {
    const mcpServers = {
      "paco-plugins": {
        command: "/usr/bin/node",
        args: ["scripts/plugin-mcp-server.ts"],
        env: { PACO_INTERNAL_TOKEN: "secret" },
      },
    };
    const args = buildArgs({ cwd: "/tmp/ws", mcpServers });

    const index = args.indexOf("--mcp-config");
    expect(index).toBeGreaterThan(-1);
    const value = args[index + 1] as string;

    // Inline JSON would put the plugin-tools bearer token in this process's
    // argv, where `ps auxww` — and the agent's own Bash tool — can read it.
    // AGENTS.md: "The token goes in the environment, never in argv."
    expect(args.join(" ")).not.toContain("secret");
    expect(value).not.toContain("{");
    expect(JSON.parse(readFileSync(value, "utf-8"))).toEqual({ mcpServers });

    cleanupMcpConfigFile(args);

    // The reproducibility contract: only servers named via --mcp-config are
    // reachable, never anything already configured on the host.
    expect(args).toContain("--strict-mcp-config");
  });
});
