import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanupMcpConfigFile,
  MCP_CONFIG_FLAG,
  writeMcpConfigFile,
} from "./mcp-config-file.ts";

const written: string[] = [];

function write(servers: Parameters<typeof writeMcpConfigFile>[0]): string {
  const path = writeMcpConfigFile(servers);
  written.push(path);
  return path;
}

afterEach(() => {
  for (const path of written.splice(0)) {
    cleanupMcpConfigFile([MCP_CONFIG_FLAG, path]);
  }
});

const SERVERS = {
  "paco-plugins": {
    command: "/usr/bin/node",
    args: ["/home/paco/.paco/mcp/plugin-mcp-server.ts"],
    env: { PACO_INTERNAL_TOKEN: "the-6-hour-plugin-tools-bearer-token" },
  },
};

describe("writeMcpConfigFile", () => {
  test("writes exactly the payload the CLI expects", () => {
    const path = write(SERVERS);

    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      mcpServers: SERVERS,
    });
  });

  test("gives the file and its directory owner-only permissions", () => {
    const path = write(SERVERS);

    // The file holds bearer tokens. `ps` cannot see it (that is the point of
    // using a file at all), but every other account on the machine could
    // read it if the mode were the usual 0644.
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  });

  test("never reuses a path between calls", () => {
    expect(write(SERVERS)).not.toBe(write(SERVERS));
  });
});

describe("cleanupMcpConfigFile", () => {
  test("removes the file named after --mcp-config, and its directory", () => {
    const path = writeMcpConfigFile(SERVERS);
    const dir = dirname(path);

    cleanupMcpConfigFile(["-p", MCP_CONFIG_FLAG, path, "--verbose"]);

    expect(existsSync(path)).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  test("does nothing when the argv carries no --mcp-config", () => {
    expect(() => cleanupMcpConfigFile(["-p", "--verbose"])).not.toThrow();
  });

  test("is safe to call twice", () => {
    const path = writeMcpConfigFile(SERVERS);

    cleanupMcpConfigFile([MCP_CONFIG_FLAG, path]);
    expect(() => cleanupMcpConfigFile([MCP_CONFIG_FLAG, path])).not.toThrow();
  });

  test("refuses a path it did not write, so a stray flag value cannot delete a directory", () => {
    // `--mcp-config` also accepts an inline JSON string and an operator's own
    // config path. Cleanup must only ever remove the private directory this
    // module created.
    cleanupMcpConfigFile([MCP_CONFIG_FLAG, "/etc"]);
    cleanupMcpConfigFile([MCP_CONFIG_FLAG, '{"mcpServers":{}}']);

    expect(existsSync("/etc")).toBe(true);
  });
});
