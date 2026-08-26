import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import type { Capability, PluginDescriptor } from "@paco/plugin-kit";
import { discoverPlugin } from "@paco/plugin-kit";
import {
  buildWorkerArgv,
  type CapabilityHandlers,
  type HostLogEntry,
  PluginHost,
  resolvePluginHostDir,
  workerEntryPath,
  workerPreloadPath,
} from "./host.ts";
import { checkFetchAllowed, isFetchAllowed } from "./net-allowlist.ts";
import { registeredToolSchema, workerToHostSchema } from "./protocol.ts";

let rootDir: string;
const running: PluginHost[] = [];

/** Every fixture plugin root gets this so `.js` slot files load as ESM. */
const ESM_PACKAGE_JSON = JSON.stringify({ type: "module" });

function manifest(
  name: string,
  capabilities: Capability[],
  netDomains?: string[],
) {
  return JSON.stringify({
    name,
    version: "1.0.0",
    description: "Fixture plugin.",
    pacoApi: 1,
    capabilities,
    ...(capabilities.includes("net:fetch")
      ? { netDomains: netDomains ?? ["example.com"] }
      : {}),
  });
}

/**
 * Writes a real plugin directory to a tmp dir and discovers it, so the host
 * under test spawns a real worker process against real files on disk.
 */
async function writePlugin(
  name: string,
  capabilities: Capability[],
  files: Record<string, string>,
  netDomains?: string[],
): Promise<PluginDescriptor> {
  const pluginDir = path.join(rootDir, name);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, "plugin.json"),
    manifest(name, capabilities, netDomains),
  );
  await writeFile(path.join(pluginDir, "package.json"), ESM_PACKAGE_JSON);

  for (const [relative, contents] of Object.entries(files)) {
    const filePath = path.join(pluginDir, relative);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }

  const discovered = await discoverPlugin(pluginDir);
  if (!discovered.ok) {
    throw new Error(`fixture ${name} did not discover: ${discovered.error}`);
  }
  return discovered.plugin;
}

interface HostFixtureOptions {
  descriptor: PluginDescriptor;
  grantedCapabilities: Capability[];
  netDomains?: string[];
  handlers?: CapabilityHandlers;
  logs?: HostLogEntry[];
  readyTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

/**
 * Builds a host in NON-hardened mode.
 *
 * These tests run under `bun test`, so `process.execPath` is bun, which has
 * no permission model and would reject `--permission`. The hardened path is
 * covered separately, against a real Node binary, in "worker containment"
 * below. Everything else — the RPC protocol, grant enforcement, crash and
 * timeout handling — is runtime-independent and is exercised here.
 */
function makeHost(options: HostFixtureOptions): PluginHost {
  const logs = options.logs;
  const host = new PluginHost({
    descriptor: options.descriptor,
    grantedCapabilities: options.grantedCapabilities,
    netDomains: options.netDomains ?? [],
    handlers: options.handlers ?? {},
    hardened: false,
    logger: logs ? (entry) => logs.push(entry) : undefined,
    readyTimeoutMs: options.readyTimeoutMs,
    shutdownTimeoutMs: options.shutdownTimeoutMs,
  });
  running.push(host);
  return host;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "plugin-host-"));
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((host) => host.stop()));
  await rm(rootDir, { recursive: true, force: true });
});

const ECHO_TOOL = `export default {
  name: "echo",
  description: "Echoes its input back.",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  execute(input) {
    return { echoed: input.text };
  },
};
`;

describe("PluginHost start", () => {
  test("completes the ready handshake and registers tools", async () => {
    const descriptor = await writePlugin("echo-plugin", ["tools:register"], {
      "tools/echo.js": ECHO_TOOL,
    });
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
    });

    const { tools } = await host.start();

    expect(host.state).toBe("running");
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("echo");
    expect(tools[0]?.description).toBe("Echoes its input back.");
    expect(tools[0]?.inputSchema).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
    });
  });

  test("round-trips a tool invocation through the worker process", async () => {
    const descriptor = await writePlugin("echo-plugin", ["tools:register"], {
      "tools/echo.js": ECHO_TOOL,
    });
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
    });
    await host.start();

    const outcome = await host.invokeTool("echo", { text: "hello" });

    expect(outcome).toEqual({ ok: true, output: { echoed: "hello" } });
  });

  test("reports a thrown tool error without killing the worker", async () => {
    const descriptor = await writePlugin("boom-plugin", ["tools:register"], {
      "tools/boom.js": `export default {
        name: "boom",
        description: "Always throws.",
        inputSchema: {},
        execute() {
          throw new Error("kaboom");
        },
      };
      `,
    });
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
    });
    await host.start();

    const outcome = await host.invokeTool("boom", {});

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain("kaboom");
    expect(host.state).toBe("running");
  });

  test("rejects a descriptor whose plugin id is not a valid id", async () => {
    const descriptor = await writePlugin("ok-plugin", ["tools:register"], {
      "tools/echo.js": ECHO_TOOL,
    });
    const tampered: PluginDescriptor = {
      ...descriptor,
      manifest: { ...descriptor.manifest, name: "Not A Valid Id" },
    };

    expect(
      () =>
        new PluginHost({
          descriptor: tampered,
          grantedCapabilities: [],
          netDomains: [],
          handlers: {},
        }),
    ).toThrow(/invalid plugin id/);
  });
});

describe("PluginHost capability enforcement", () => {
  test("runs the handler for a granted capability", async () => {
    const descriptor = await writePlugin(
      "kv-plugin",
      ["tools:register", "storage:kv"],
      {
        "tools/remember.js": `export default {
          name: "remember",
          description: "Writes then reads a key.",
          inputSchema: {},
          async execute(input, api) {
            await api.kv.set("greeting", "hi");
            return { readBack: await api.kv.get("greeting") };
          },
        };
        `,
      },
    );

    const store = new Map<string, unknown>();
    const seenPluginIds: string[] = [];
    const handlers: CapabilityHandlers = {
      "storage:kv": (pluginId, payload) => {
        seenPluginIds.push(pluginId);
        const op = payload as { op: string; key: string; value?: unknown };
        if (op.op === "set") {
          store.set(op.key, op.value);
          return Promise.resolve(null);
        }
        return Promise.resolve(store.get(op.key) ?? null);
      },
    };

    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register", "storage:kv"],
      handlers,
    });
    await host.start();

    const outcome = await host.invokeTool("remember", {});

    expect(outcome).toEqual({ ok: true, output: { readBack: "hi" } });
    expect(seenPluginIds).toEqual(["kv-plugin", "kv-plugin"]);
  });

  test("denies an ungranted capability in the host, logs it, and never reaches the handler", async () => {
    const descriptor = await writePlugin("greedy-plugin", ["tools:register"], {
      "tools/steal.js": `export default {
        name: "steal",
        description: "Requests a capability it was never granted.",
        inputSchema: {},
        async execute(input, api) {
          try {
            await api.kv.get("secret");
            return { denied: false };
          } catch (error) {
            return { denied: true, message: String(error.message) };
          }
        },
      };
      `,
    });

    let handlerCalls = 0;
    const logs: HostLogEntry[] = [];
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
      handlers: {
        "storage:kv": () => {
          handlerCalls++;
          return Promise.resolve("leaked");
        },
      },
      logs,
    });
    await host.start();

    const outcome = await host.invokeTool("steal", {});

    expect(outcome.ok).toBe(true);
    expect(outcome.ok === true && outcome.output).toEqual({
      denied: true,
      message: "capability not granted: storage:kv",
    });
    expect(handlerCalls).toBe(0);
    const warning = logs.find(
      (entry) =>
        entry.level === "warn" &&
        entry.message.includes("capability not granted: storage:kv"),
    );
    expect(warning).toBeDefined();
    expect(warning?.message).toContain("greedy-plugin");
  });

  test("denies a granted capability with no handler wired", async () => {
    const descriptor = await writePlugin(
      "unwired-plugin",
      ["tools:register", "storage:kv"],
      {
        "tools/probe.js": `export default {
          name: "probe",
          description: "Calls a granted but unwired capability.",
          inputSchema: {},
          async execute(input, api) {
            try {
              await api.kv.get("k");
              return { error: null };
            } catch (error) {
              return { error: String(error.message) };
            }
          },
        };
        `,
      },
    );
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register", "storage:kv"],
      handlers: {},
    });
    await host.start();

    const outcome = await host.invokeTool("probe", {});

    expect(outcome).toEqual({
      ok: true,
      output: { error: "capability not available" },
    });
  });

  test("denies an ungranted capability requested from a hook at load time", async () => {
    const descriptor = await writePlugin("hooky-plugin", ["tools:register"], {
      "hooks/on-load.js": `export default async function onLoad(api) {
        await api.fetch({ url: "https://example.com" });
      };
      `,
      "tools/echo.js": ECHO_TOOL,
    });
    const logs: HostLogEntry[] = [];
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
      handlers: {},
      logs,
    });

    await host.start();

    expect(host.state).toBe("running");
    expect(
      logs.some(
        (entry) =>
          entry.level === "warn" &&
          entry.message.includes("capability not granted: net:fetch"),
      ),
    ).toBe(true);
  });

  test("drops a granted capability the manifest does not declare", async () => {
    const descriptor = await writePlugin("narrow-plugin", ["tools:register"], {
      "tools/probe.js": `export default {
        name: "probe",
        description: "Calls a capability the manifest never asked for.",
        inputSchema: {},
        async execute(input, api) {
          try {
            await api.kv.get("k");
            return { error: null };
          } catch (error) {
            return { error: String(error.message) };
          }
        },
      };
      `,
    });

    let handlerCalls = 0;
    const logs: HostLogEntry[] = [];
    // A stale consent row still lists storage:kv; the installed manifest no
    // longer declares it. The intersection wins.
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register", "storage:kv"],
      handlers: {
        "storage:kv": () => {
          handlerCalls++;
          return Promise.resolve("leaked");
        },
      },
      logs,
    });
    await host.start();

    const outcome = await host.invokeTool("probe", {});

    expect(outcome).toEqual({
      ok: true,
      output: { error: "capability not granted: storage:kv" },
    });
    expect(handlerCalls).toBe(0);
    expect(
      logs.some(
        (entry) =>
          entry.level === "warn" &&
          entry.message.includes(
            "dropping granted capabilities absent from the manifest: storage:kv",
          ),
      ),
    ).toBe(true);
  });

  test("drops registered tools when tools:register is not granted", async () => {
    const descriptor = await writePlugin("toolsy-plugin", ["tools:register"], {
      "tools/echo.js": ECHO_TOOL,
    });
    const logs: HostLogEntry[] = [];
    const host = makeHost({
      descriptor,
      grantedCapabilities: [],
      logs,
    });

    const { tools } = await host.start();

    expect(tools).toEqual([]);
    expect(
      logs.some(
        (entry) =>
          entry.level === "warn" &&
          entry.message.includes("capability not granted: tools:register"),
      ),
    ).toBe(true);
  });

  test("refuses capability requests once stop() has begun", async () => {
    const descriptor = await writePlugin(
      "ticker-plugin",
      ["tools:register", "storage:kv"],
      {
        "hooks/tick.js": `export default function tick(api) {
          setInterval(() => {
            api.kv
              .get("tick")
              .catch((error) => api.log("error", "tick failed: " + error.message));
          }, 25);
          // Ignore the graceful shutdown so the worker is still alive, and
          // still ticking, for the whole shutdown window.
          process.exit = () => {};
        };
        `,
        "tools/echo.js": ECHO_TOOL,
      },
    );
    const logs: HostLogEntry[] = [];
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register", "storage:kv"],
      handlers: { "storage:kv": () => Promise.resolve("v") },
      logs,
      shutdownTimeoutMs: 400,
    });
    await host.start();
    await delay(80);

    await host.stop();

    expect(
      logs.some((entry) =>
        entry.message.includes("tick failed: plugin is shutting down"),
      ),
    ).toBe(true);
  });

  test("rejects capability requests beyond the in-flight cap", async () => {
    const descriptor = await writePlugin(
      "flood-plugin",
      ["tools:register", "storage:kv"],
      {
        "tools/flood.js": `export default {
          name: "flood",
          description: "Issues many concurrent capability requests.",
          inputSchema: {},
          async execute(input, api) {
            const results = await Promise.allSettled(
              Array.from({ length: 36 }, (unused, i) => api.kv.get("k" + i)),
            );
            return {
              rejected: results
                .filter((r) => r.status === "rejected")
                .map((r) => String(r.reason.message)),
            };
          },
        };
        `,
      },
    );
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register", "storage:kv"],
      handlers: {
        // Slow enough that all 36 are outstanding at once.
        "storage:kv": () => delay(300).then(() => "v"),
      },
    });
    await host.start();

    const outcome = await host.invokeTool("flood", {}, 5000);

    expect(outcome.ok).toBe(true);
    const output =
      outcome.ok === true
        ? (outcome.output as { rejected: string[] })
        : { rejected: [] };
    // 36 requests against a cap of 32 leaves 4 rejections — below the
    // malformed budget of 5, so the plugin survives to report them.
    expect(output.rejected).toHaveLength(4);
    expect(new Set(output.rejected)).toEqual(
      new Set(["capability request queue full"]),
    );
    expect(host.state).toBe("running");
  });

  test("kills a worker that floods past the in-flight cap repeatedly", async () => {
    const descriptor = await writePlugin(
      "megaflood-plugin",
      ["tools:register", "storage:kv"],
      {
        "tools/flood.js": `export default {
          name: "flood",
          description: "Issues far too many concurrent capability requests.",
          inputSchema: {},
          async execute(input, api) {
            await Promise.allSettled(
              Array.from({ length: 64 }, (unused, i) => api.kv.get("k" + i)),
            );
            return { done: true };
          },
        };
        `,
      },
    );
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register", "storage:kv"],
      handlers: { "storage:kv": () => delay(300).then(() => "v") },
    });
    const crashes: string[] = [];
    host.onCrash((error) => crashes.push(error));
    await host.start();

    const outcome = await host.invokeTool("flood", {}, 5000);

    expect(outcome.ok).toBe(false);
    expect(host.state).toBe("crashed");
    expect(crashes[0]).toContain("malformed");
  });

  test("rate-limits worker log messages", async () => {
    const descriptor = await writePlugin("chatty-plugin", ["tools:register"], {
      "tools/spam.js": `export default {
        name: "spam",
        description: "Logs far too much.",
        inputSchema: {},
        execute(input, api) {
          for (let i = 0; i < 300; i++) {
            api.log("info", "spam " + i);
          }
          return { logged: 300 };
        },
      };
      `,
    });
    const logs: HostLogEntry[] = [];
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
      logs,
    });
    await host.start();

    await host.invokeTool("spam", {});
    await delay(100);

    const spam = logs.filter((entry) => entry.message.includes("spam "));
    expect(spam.length).toBeGreaterThan(0);
    expect(spam.length).toBeLessThanOrEqual(50);
    expect(
      logs.some(
        (entry) =>
          entry.level === "warn" &&
          entry.message.includes("log rate limit exceeded"),
      ),
    ).toBe(true);
  });
});

describe("PluginHost net:fetch allowlist", () => {
  const FETCH_TOOL = `export default {
    name: "call",
    description: "Fetches a url through the capability api.",
    inputSchema: {},
    async execute(input, api) {
      try {
        return { allowed: true, response: await api.fetch({ url: input.url }) };
      } catch (error) {
        return { allowed: false, message: String(error.message) };
      }
    },
  };
  `;

  /**
   * The manifest asks for one domain; the host is handed a different,
   * CONSENTED list. Only the consented one may be used — see the
   * "ignores the manifest's netDomains" test.
   */
  async function fetchHost(consented: string[]): Promise<{
    host: PluginHost;
    reached: unknown[];
    logs: HostLogEntry[];
  }> {
    const descriptor = await writePlugin(
      "fetch-plugin",
      ["tools:register", "net:fetch"],
      { "tools/call.js": FETCH_TOOL },
      ["manifest-only.example"],
    );
    const reached: unknown[] = [];
    const logs: HostLogEntry[] = [];
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register", "net:fetch"],
      netDomains: consented,
      handlers: {
        "net:fetch": (_pluginId, payload) => {
          reached.push(payload);
          return Promise.resolve({ status: 200, headers: {}, body: "ok" });
        },
      },
      logs,
    });
    await host.start();
    return { host, reached, logs };
  }

  async function attempt(
    host: PluginHost,
    url: string,
  ): Promise<{ allowed: boolean; message?: string; response?: unknown }> {
    const outcome = await host.invokeTool("call", { url });
    if (!outcome.ok) {
      throw new Error(`invokeTool failed: ${outcome.error}`);
    }
    return outcome.output as {
      allowed: boolean;
      message?: string;
      response?: unknown;
    };
  }

  test("passes an exactly-matching host through to the handler", async () => {
    const { host, reached } = await fetchHost(["api.example.com"]);

    const result = await attempt(host, "https://api.example.com/v1/issues");

    expect(result.allowed).toBe(true);
    expect(result.response).toEqual({ status: 200, headers: {}, body: "ok" });
    expect(reached).toEqual([{ url: "https://api.example.com/v1/issues" }]);
  });

  test("allows plain http as well as https", async () => {
    const { host, reached } = await fetchHost(["api.example.com"]);

    const result = await attempt(host, "http://api.example.com/");

    expect(result.allowed).toBe(true);
    expect(reached).toHaveLength(1);
  });

  test("uses the consented netDomains and ignores the manifest's", async () => {
    const { host, reached } = await fetchHost(["api.example.com"]);

    // The fixture's own manifest declares "manifest-only.example". If the
    // host trusted the manifest, a plugin update could widen its own reach.
    const fromManifest = await attempt(host, "https://manifest-only.example/");

    expect(fromManifest).toEqual({
      allowed: false,
      message: "net:fetch denied: host manifest-only.example not in netDomains",
    });
    expect(reached).toEqual([]);
  });

  test("rejects a subdomain of an allowed host", async () => {
    const { host, reached, logs } = await fetchHost(["api.example.com"]);

    const result = await attempt(host, "https://evil.api.example.com/steal");

    expect(result).toEqual({
      allowed: false,
      message: "net:fetch denied: host evil.api.example.com not in netDomains",
    });
    expect(reached).toEqual([]);
    expect(
      logs.some(
        (entry) =>
          entry.level === "warn" &&
          entry.message.includes(
            "net:fetch denied: host evil.api.example.com not in netDomains",
          ),
      ),
    ).toBe(true);
  });

  test("rejects the parent domain of an allowed host", async () => {
    const { host, reached } = await fetchHost(["api.example.com"]);

    const result = await attempt(host, "https://example.com/");

    expect(result).toEqual({
      allowed: false,
      message: "net:fetch denied: host example.com not in netDomains",
    });
    expect(reached).toEqual([]);
  });

  test("rejects a non-http scheme", async () => {
    const { host, reached, logs } = await fetchHost(["api.example.com"]);

    const result = await attempt(host, "file:///etc/passwd");

    expect(result).toEqual({
      allowed: false,
      message: "net:fetch denied: scheme file: not allowed",
    });
    expect(reached).toEqual([]);
    expect(logs.some((entry) => entry.level === "warn")).toBe(true);
  });

  test("rejects an ip literal even when it would otherwise match", async () => {
    const { host, reached } = await fetchHost(["127.0.0.1"]);

    const result = await attempt(host, "http://127.0.0.1:8080/admin");

    expect(result).toEqual({
      allowed: false,
      message: "net:fetch denied: ip literal 127.0.0.1 not allowed",
    });
    expect(reached).toEqual([]);
  });

  test("rejects an unparsable url", async () => {
    const { host, reached } = await fetchHost(["api.example.com"]);

    const result = await attempt(host, "not a url at all");

    expect(result.allowed).toBe(false);
    expect(result.message).toBe(
      "net:fetch denied: unparsable url not a url at all",
    );
    expect(reached).toEqual([]);
  });

  test("rejects a payload with no url at all", async () => {
    const descriptor = await writePlugin(
      "urlless-plugin",
      ["tools:register", "net:fetch"],
      {
        "tools/call.js": `export default {
          name: "call",
          description: "Sends a malformed fetch payload.",
          inputSchema: {},
          async execute(input, api) {
            try {
              return { allowed: true, response: await api.fetch({ nope: 1 }) };
            } catch (error) {
              return { allowed: false, message: String(error.message) };
            }
          },
        };
        `,
      },
    );
    let reached = 0;
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register", "net:fetch"],
      netDomains: ["api.example.com"],
      handlers: {
        "net:fetch": () => {
          reached++;
          return Promise.resolve(null);
        },
      },
    });
    await host.start();

    const outcome = await host.invokeTool("call", {});

    expect(outcome).toEqual({
      ok: true,
      output: {
        allowed: false,
        message: "net:fetch denied: payload has no url",
      },
    });
    expect(reached).toBe(0);
  });

  test("matches hostnames case-insensitively", async () => {
    const { host, reached } = await fetchHost(["api.example.com"]);

    const result = await attempt(host, "https://API.EXAMPLE.COM/x");

    expect(result.allowed).toBe(true);
    expect(reached).toHaveLength(1);
  });
});

describe("isFetchAllowed", () => {
  const domains = ["api.example.com", "example.org"];

  test("accepts an exact match on either scheme", () => {
    expect(isFetchAllowed("https://api.example.com/x", domains)).toBe(true);
    expect(isFetchAllowed("http://example.org", domains)).toBe(true);
  });

  test("normalizes case and one trailing dot on both sides", () => {
    expect(isFetchAllowed("https://API.Example.com./x", domains)).toBe(true);
    expect(
      isFetchAllowed("https://api.example.com", ["API.EXAMPLE.COM."]),
    ).toBe(true);
    // Two trailing dots is not a name that normalizes to anything real.
    expect(isFetchAllowed("https://api.example.com../x", domains)).toBe(false);
  });

  test("refuses subdomains and parent domains alike", () => {
    expect(isFetchAllowed("https://evil.api.example.com/", domains)).toBe(
      false,
    );
    expect(isFetchAllowed("https://example.com/", domains)).toBe(false);
    expect(isFetchAllowed("https://api.example.com.evil.test/", domains)).toBe(
      false,
    );
  });

  test("refuses ip literals in both families", () => {
    expect(isFetchAllowed("http://127.0.0.1/", ["127.0.0.1"])).toBe(false);
    expect(isFetchAllowed("http://169.254.169.254/", ["169.254.169.254"])).toBe(
      false,
    );
    // WHATWG normalizes these shorthand forms to dotted quads.
    expect(isFetchAllowed("http://127.1/", ["127.0.0.1"])).toBe(false);
    expect(isFetchAllowed("http://0x7f000001/", ["127.0.0.1"])).toBe(false);
    expect(isFetchAllowed("http://[::1]/", ["::1"])).toBe(false);
  });

  test("refuses non-http schemes and unparsable urls", () => {
    expect(isFetchAllowed("file:///etc/passwd", domains)).toBe(false);
    expect(isFetchAllowed("ftp://example.org/", domains)).toBe(false);
    expect(isFetchAllowed("data:text/plain,hi", domains)).toBe(false);
    expect(isFetchAllowed("nonsense", domains)).toBe(false);
  });

  test("refuses everything when the consented list is empty", () => {
    expect(isFetchAllowed("https://api.example.com/", [])).toBe(false);
  });

  test("reports why it refused", () => {
    expect(checkFetchAllowed("https://nope.test/", domains)).toEqual({
      allowed: false,
      reason: "net:fetch denied: host nope.test not in netDomains",
    });
    expect(checkFetchAllowed("https://api.example.com/", domains)).toEqual({
      allowed: true,
      hostname: "api.example.com",
    });
  });
});

describe("registeredToolSchema bounds", () => {
  test("accepts a well-formed tool", () => {
    expect(
      registeredToolSchema.safeParse({
        name: "do_thing-2",
        description: "Does the thing.",
        inputSchema: {},
      }).success,
    ).toBe(true);
  });

  test("refuses names that are not lowercase identifiers", () => {
    for (const name of ["BadName", "9lives", "has space", "-leading", ""]) {
      expect(
        registeredToolSchema.safeParse({
          name,
          description: "x",
          inputSchema: {},
        }).success,
      ).toBe(false);
    }
  });

  test("refuses an over-long name or description", () => {
    expect(
      registeredToolSchema.safeParse({
        name: "a".repeat(65),
        description: "x",
        inputSchema: {},
      }).success,
    ).toBe(false);
    expect(
      registeredToolSchema.safeParse({
        name: "ok",
        description: "x".repeat(1001),
        inputSchema: {},
      }).success,
    ).toBe(false);
  });

  test("refuses a ready message with more than 64 tools", () => {
    const tool = { name: "ok", description: "x", inputSchema: {} };
    expect(
      workerToHostSchema.safeParse({
        kind: "ready",
        tools: Array.from({ length: 64 }, () => tool),
      }).success,
    ).toBe(true);
    expect(
      workerToHostSchema.safeParse({
        kind: "ready",
        tools: Array.from({ length: 65 }, () => tool),
      }).success,
    ).toBe(false);
  });

  test("a worker registering an invalid tool name never becomes ready", async () => {
    const descriptor = await writePlugin("badname-plugin", ["tools:register"], {
      "tools/bad.js": `export default {
        name: "BadName",
        description: "Uppercase names do not belong in an MCP tool list.",
        inputSchema: {},
        execute() {
          return {};
        },
      };
      `,
    });
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
      readyTimeoutMs: 600,
    });

    await expect(host.start()).rejects.toThrow();
    expect(host.state).toBe("crashed");
  });
});

describe("PluginHost worker environment", () => {
  test("gives the worker exactly PATH, PACO_PLUGIN_ID and PACO_PLUGIN_STATE_DIR", async () => {
    const descriptor = await writePlugin("env-plugin", ["tools:register"], {
      "tools/env.js": `export default {
        name: "env",
        description: "Reports its own environment.",
        inputSchema: {},
        execute() {
          return {
            keys: Object.keys(process.env),
            pluginId: process.env.PACO_PLUGIN_ID,
            stateDir: process.env.PACO_PLUGIN_STATE_DIR,
          };
        },
      };
      `,
    });
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
    });
    await host.start();

    const outcome = await host.invokeTool("env", {});

    expect(outcome.ok).toBe(true);
    const output =
      outcome.ok === true
        ? (outcome.output as {
            keys: string[];
            pluginId: string;
            stateDir: string;
          })
        : { keys: [], pluginId: "", stateDir: "" };
    expect([...output.keys].sort()).toEqual([
      "PACO_PLUGIN_ID",
      "PACO_PLUGIN_STATE_DIR",
      "PATH",
    ]);
    expect(output.pluginId).toBe("env-plugin");
    expect(output.stateDir).toBe(host.pluginStateDir);
  });

  test("sends plugin console output to stderr rather than the protocol stream", async () => {
    const descriptor = await writePlugin("noisy-console", ["tools:register"], {
      "tools/talk.js": `export default {
        name: "talk",
        description: "Writes to console before returning.",
        inputSchema: {},
        execute() {
          console.log("this would corrupt the protocol stream");
          console.error("and so would this");
          return { fine: true };
        },
      };
      `,
    });
    const logs: HostLogEntry[] = [];
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
      logs,
    });
    await host.start();

    const outcome = await host.invokeTool("talk", {});

    expect(outcome).toEqual({ ok: true, output: { fine: true } });
    expect(host.state).toBe("running");
    expect(logs.some((entry) => entry.message.includes("not JSON"))).toBe(
      false,
    );
  });
});

describe("PluginHost failure handling", () => {
  test("kills the worker after five malformed messages and reports a crash", async () => {
    const descriptor = await writePlugin("garbage-plugin", ["tools:register"], {
      "tools/echo.js": ECHO_TOOL,
      "hooks/flood.js": `export default function flood() {
        for (let i = 0; i < 12; i++) {
          process.stdout.write("this is not json\\n");
        }
      };
      `,
    });
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
    });

    const crashes: string[] = [];
    host.onCrash((error) => crashes.push(error));

    await expect(host.start()).rejects.toThrow();

    expect(host.state).toBe("crashed");
    expect(crashes).toHaveLength(1);
    expect(crashes[0]).toContain("malformed");
  });

  test("counts malformed messages and survives fewer than five", async () => {
    const descriptor = await writePlugin("noisy-plugin", ["tools:register"], {
      "tools/echo.js": ECHO_TOOL,
      "hooks/noise.js": `export default function noise() {
        for (let i = 0; i < 4; i++) {
          process.stdout.write("{\\"kind\\":\\"nope\\"}\\n");
        }
      };
      `,
    });
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
    });

    const { tools } = await host.start();

    expect(host.state).toBe("running");
    expect(tools.map((tool) => tool.name)).toEqual(["echo"]);
  });

  test("kills a worker that writes a line past the size cap", async () => {
    const descriptor = await writePlugin("bloated-plugin", ["tools:register"], {
      "tools/echo.js": ECHO_TOOL,
      "hooks/bloat.js": `export default function bloat() {
        // Well past the 64 KiB cap, with no newline in sight: readline would
        // buffer this forever waiting for one that never comes.
        process.stdout.write("x".repeat(200000));
      };
      `,
    });
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
    });
    const crashes: string[] = [];
    host.onCrash((error) => crashes.push(error));

    await expect(host.start()).rejects.toThrow(/newline/);

    expect(host.state).toBe("crashed");
    expect(crashes[0]).toContain("without a newline");
  });

  test("detects a worker that exits mid-run and never throws into the embedder", async () => {
    const descriptor = await writePlugin(
      "suicidal-plugin",
      ["tools:register"],
      {
        "tools/die.js": `export default {
        name: "die",
        description: "Exits the worker process.",
        inputSchema: {},
        execute() {
          process.exit(3);
        },
      };
      `,
      },
    );
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
    });

    const crashes: string[] = [];
    host.onCrash((error) => crashes.push(error));
    await host.start();

    const outcome = await host.invokeTool("die", {});

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain("crashed");
    expect(host.state).toBe("crashed");
    expect(crashes).toHaveLength(1);

    // A second invocation on a crashed host still resolves rather than throwing.
    const after = await host.invokeTool("die", {});
    expect(after.ok).toBe(false);

    // And stopping the corpse does not launder the crash into a clean stop.
    await host.stop();
    expect(host.state).toBe("crashed");
  });

  test("times out a hung tool invocation, cancels it, and stays running", async () => {
    const descriptor = await writePlugin("slow-plugin", ["tools:register"], {
      "tools/hang.js": `export default {
        name: "hang",
        description: "Never resolves unless cancelled.",
        inputSchema: {},
        execute(input, api, signal) {
          return new Promise(() => {
            signal.addEventListener("abort", () => {
              globalThis.__aborted = true;
            });
          });
        },
      };
      `,
      "tools/aborted.js": `export default {
        name: "aborted",
        description: "Reports whether the hung call was cancelled.",
        inputSchema: {},
        execute() {
          return { aborted: globalThis.__aborted === true };
        },
      };
      `,
    });
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
    });
    await host.start();

    const outcome = await host.invokeTool("hang", {}, 250);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain("timed out");
    expect(host.state).toBe("running");

    // The worker was told to give up, so the tool's AbortSignal fired.
    await delay(50);
    const cancelled = await host.invokeTool("aborted", {});
    expect(cancelled).toEqual({ ok: true, output: { aborted: true } });
  });

  test("fails start when the worker never becomes ready", async () => {
    const descriptor = await writePlugin("stuck-plugin", ["tools:register"], {
      "hooks/stall.js": `export default function stall() {
        return new Promise(() => {});
      };
      `,
    });
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
      readyTimeoutMs: 300,
    });

    await expect(host.start()).rejects.toThrow(/ready/i);
    expect(host.state).toBe("crashed");
  });

  test("fails start when the host is stopped mid-handshake", async () => {
    const descriptor = await writePlugin(
      "slowstart-plugin",
      ["tools:register"],
      {
        "hooks/stall.js": `export default function stall() {
        return new Promise(() => {});
      };
      `,
      },
    );
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
      readyTimeoutMs: 10_000,
    });

    const starting = host.start();
    await delay(150);
    const stopping = host.stop();

    await expect(starting).rejects.toThrow(/stopped during startup/);
    await stopping;
    expect(host.state).toBe("stopped");
  });
});

describe("PluginHost stop", () => {
  test("stops a cooperative worker gracefully", async () => {
    const descriptor = await writePlugin("polite-plugin", ["tools:register"], {
      "tools/echo.js": ECHO_TOOL,
    });
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
    });
    await host.start();

    await host.stop();

    expect(host.state).toBe("stopped");
    // A stopped host declines work instead of throwing.
    const outcome = await host.invokeTool("echo", { text: "hi" });
    expect(outcome.ok).toBe(false);
  });

  test("force-kills a worker that ignores shutdown", async () => {
    const descriptor = await writePlugin(
      "stubborn-plugin",
      ["tools:register"],
      {
        "tools/echo.js": ECHO_TOOL,
        "hooks/ignore-shutdown.js": `export default function ignoreShutdown() {
        // Keep the event loop alive forever and swallow the host's shutdown
        // message by overriding the process exit path.
        setInterval(() => {}, 1000);
        process.exit = () => {};
      };
      `,
      },
    );
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
      shutdownTimeoutMs: 300,
    });
    await host.start();

    const startedAt = Date.now();
    await host.stop();
    const elapsed = Date.now() - startedAt;

    expect(host.state).toBe("stopped");
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(3000);
  });

  test("kills the worker's whole process group, not just the worker", async () => {
    // A worker can only spawn a grandchild in NON-hardened mode: under the
    // permission model `node:child_process` is refused outright. This test
    // therefore covers the fallback case — an unhardened worker, or a future
    // one granted child processes — where a tree kill is what stops orphans.
    const descriptor = await writePlugin("spawner-plugin", ["tools:register"], {
      "tools/spawn.js": `import { spawn } from "node:child_process";
      export default {
        name: "spawn-child",
        description: "Spawns a long-lived grandchild process.",
        inputSchema: {},
        execute() {
          const child = spawn("/bin/sh", ["-c", "exec sleep 30"], {
            stdio: "ignore",
          });
          child.unref();
          return { pid: child.pid };
        },
      };
      `,
      "hooks/ignore-shutdown.js": `export default function ignoreShutdown() {
        setInterval(() => {}, 1000);
        process.exit = () => {};
      };
      `,
    });
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
      shutdownTimeoutMs: 300,
    });
    await host.start();

    const outcome = await host.invokeTool("spawn-child", {});
    expect(outcome.ok).toBe(true);
    const grandchildPid = (
      outcome.ok === true ? (outcome.output as { pid: number }) : { pid: 0 }
    ).pid;
    expect(grandchildPid).toBeGreaterThan(0);
    // Signal 0 probes for existence without delivering anything.
    expect(() => process.kill(grandchildPid, 0)).not.toThrow();

    await host.stop();
    await delay(200);

    expect(() => process.kill(grandchildPid, 0)).toThrow();
  });

  test("is idempotent and safe on a host that never started", async () => {
    const descriptor = await writePlugin("idle-plugin", ["tools:register"], {
      "tools/echo.js": ECHO_TOOL,
    });
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
    });

    await host.stop();
    await host.stop();

    expect(host.state).toBe("stopped");
  });
});

describe("PluginHost deliverEvent", () => {
  const LISTENER_HOOK = `export default function listen(api) {
    globalThis.__seen = [];
    api.events.subscribe((event) => {
      globalThis.__seen.push(event);
    });
  };
  `;
  const SEEN_TOOL = `export default {
    name: "seen",
    description: "Returns the events observed so far.",
    inputSchema: {},
    execute() {
      return { seen: globalThis.__seen ?? [] };
    },
  };
  `;

  test("fans an event out to a subscriber when events:subscribe is granted", async () => {
    const descriptor = await writePlugin(
      "listener-plugin",
      ["tools:register", "events:subscribe"],
      { "hooks/listen.js": LISTENER_HOOK, "tools/seen.js": SEEN_TOOL },
    );
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register", "events:subscribe"],
    });
    await host.start();

    host.deliverEvent(1, "chat-1", { type: "message" });

    // The event is fire-and-forget, so poll the worker until it lands.
    let seen: unknown[] = [];
    for (let attempt = 0; attempt < 20 && seen.length === 0; attempt++) {
      const outcome = await host.invokeTool("seen", {});
      if (outcome.ok) {
        seen = (outcome.output as { seen: unknown[] }).seen;
      }
    }

    expect(seen).toEqual([
      { id: 1, chatId: "chat-1", event: { type: "message" } },
    ]);
  });

  test("drops events when events:subscribe is not granted", async () => {
    const descriptor = await writePlugin(
      "deaf-plugin",
      ["tools:register", "events:subscribe"],
      { "hooks/listen.js": LISTENER_HOOK, "tools/seen.js": SEEN_TOOL },
    );
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
    });
    await host.start();

    host.deliverEvent(1, "chat-1", { type: "message" });
    await delay(100);

    const outcome = await host.invokeTool("seen", {});
    expect(outcome).toEqual({ ok: true, output: { seen: [] } });
  });
});

describe("PluginHost plugin tree containment", () => {
  test("refuses to start a plugin whose directory contains a symlink", async () => {
    const descriptor = await writePlugin("linky-plugin", ["tools:register"], {
      "tools/echo.js": ECHO_TOOL,
    });
    // The escape the adversarial review used: the permission model happily
    // follows a link that lives under an allowed prefix, so this one link
    // would grant the whole filesystem.
    await symlink("/", path.join(descriptor.rootDir, "escape"));
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
    });

    await expect(host.start()).rejects.toThrow(/symbolic link/);
    expect(host.state).toBe("crashed");
  });

  test("names the offending path and finds links nested in subdirectories", async () => {
    const descriptor = await writePlugin("nested-link", ["tools:register"], {
      "tools/echo.js": ECHO_TOOL,
    });
    const linkPath = path.join(descriptor.rootDir, "tools", "sneaky");
    await symlink("/etc", linkPath);
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
    });

    await expect(host.start()).rejects.toThrow(/sneaky/);
    expect(host.state).toBe("crashed");
  });

  test("starts normally when the tree holds no links", async () => {
    const descriptor = await writePlugin("clean-plugin", ["tools:register"], {
      "tools/echo.js": ECHO_TOOL,
      "lib/nested/helper.js": "export const x = 1;\n",
    });
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
    });

    const { tools } = await host.start();

    expect(host.state).toBe("running");
    expect(tools.map((tool) => tool.name)).toEqual(["echo"]);
  });
});

/**
 * A Node binary usable for the containment suite, with its version.
 *
 * The suite runs against TWO tiers where both are available, because they
 * contain differently:
 *
 * - **Node >= 24** gates sockets in the permission model itself, so a plugin
 *   that somehow reached `net` still cannot connect.
 * - **Node 22.x** does not. There, the JS-level denial in `worker-preload.ts`
 *   is the ONLY barrier — which is exactly why it has to be tested there.
 */
interface NodeCandidate {
  path: string;
  version: string;
  major: number;
  minor: number;
}

function probeNode(candidate: string): NodeCandidate | undefined {
  try {
    const version = execFileSync(
      candidate,
      ["--permission", "-e", "process.stdout.write(process.versions.node)"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const [major = 0, minor = 0] = version.split(".").map(Number);
    // 22.15 is the floor for the synchronous `module.registerHooks` the
    // network preload depends on.
    if (major > 22 || (major === 22 && minor >= 15)) {
      return { path: candidate, version, major, minor };
    }
  } catch {
    // Not a usable Node: no --permission, or not a Node at all.
  }
  return undefined;
}

/** Every Node binary worth probing: explicit, on PATH, or version-managed. */
function nodeCandidatePaths(): string[] {
  const candidates = new Set<string>();
  if (process.env.PACO_NODE_EXECUTABLE) {
    candidates.add(process.env.PACO_NODE_EXECUTABLE);
  }
  for (const fixed of [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ]) {
    candidates.add(fixed);
  }
  try {
    const onPath = execFileSync("/usr/bin/env", ["which", "node"], {
      encoding: "utf-8",
    }).trim();
    if (onPath) {
      candidates.add(onPath);
    }
  } catch {
    // No node on PATH.
  }

  const home = homedir();
  const versionManagerRoots = [
    path.join(home, ".nvm/versions/node"),
    path.join(
      home,
      "Library/Application Support/Herd/config/nvm/versions/node",
    ),
    path.join(home, ".local/share/fnm/node-versions"),
    path.join(home, ".volta/tools/image/node"),
    path.join(home, ".asdf/installs/nodejs"),
  ];
  for (const root of versionManagerRoots) {
    try {
      for (const entry of readdirSync(root)) {
        candidates.add(path.join(root, entry, "bin", "node"));
        candidates.add(path.join(root, entry, "installation", "bin", "node"));
      }
    } catch {
      // This version manager is not installed.
    }
  }
  return [...candidates];
}

function newest(candidates: NodeCandidate[]): NodeCandidate | undefined {
  return candidates.sort((a, b) => b.major - a.major || b.minor - a.minor)[0];
}

const probedNodes = nodeCandidatePaths()
  .map(probeNode)
  .filter((candidate): candidate is NodeCandidate => candidate !== undefined);

const legacyNode = newest(probedNodes.filter((node) => node.major === 22));
const modernNode = newest(probedNodes.filter((node) => node.major >= 24));

function warnMissingTier(label: string): void {
  console.warn(
    `\n!!! SKIPPING the plugin worker containment suite for ${label}: no such Node was found.\n` +
      "!!! The permission model, filesystem allowlist and network denial are UNVERIFIED on that tier in this run.\n" +
      "!!! Set PACO_NODE_EXECUTABLE, or install that Node, to run them.\n",
  );
}

console.info(
  `[plugin-host tests] containment tiers: ` +
    `Node 22.x = ${legacyNode?.version ?? "NOT FOUND"} (${legacyNode?.path ?? "-"}), ` +
    `Node >= 24 = ${modernNode?.version ?? "NOT FOUND"} (${modernNode?.path ?? "-"})`,
);

/**
 * The containment suite, run once per available Node tier.
 *
 * Every test here spawns a real hardened worker: `--permission`, the fs
 * allowlist, and the network preload, exactly as production would.
 */
function describeContainment(label: string, node: NodeCandidate): void {
  describe(`worker containment (${label}, Node ${node.version})`, () => {
    const PROBE_TOOLS = {
      "tools/read-outside.js": `import { readFile } from "node:fs/promises";
      export default {
        name: "read-outside",
        description: "Tries to read a file outside the plugin directory.",
        inputSchema: {},
        async execute() {
          try {
            const text = await readFile("/etc/hosts", "utf-8");
            return { read: true, length: text.length };
          } catch (error) {
            return { read: false, code: error.code ?? String(error.message) };
          }
        },
      };
      `,
      "tools/read-own.js": `import { readFile } from "node:fs/promises";
      import * as path from "node:path";
      export default {
        name: "read-own",
        description: "Reads the plugin's own manifest.",
        inputSchema: {},
        async execute() {
          const text = await readFile(path.join(process.cwd(), "plugin.json"), "utf-8");
          return { name: JSON.parse(text).name };
        },
      };
      `,
      "tools/write-state.js": `import { readFile, writeFile } from "node:fs/promises";
      import * as path from "node:path";
      export default {
        name: "write-state",
        description: "Writes and reads back a file in the state directory.",
        inputSchema: {},
        async execute(input, api) {
          const file = path.join(api.stateDir, "scratch.txt");
          await writeFile(file, "persisted");
          return { readBack: await readFile(file, "utf-8"), stateDir: api.stateDir };
        },
      };
      `,
      "tools/write-outside.js": `import { writeFile } from "node:fs/promises";
      export default {
        name: "write-outside",
        description: "Tries to write outside the state directory.",
        inputSchema: {},
        async execute() {
          try {
            await writeFile("/tmp/paco-plugin-escape.txt", "escaped");
            return { wrote: true };
          } catch (error) {
            return { wrote: false, code: error.code ?? String(error.message) };
          }
        },
      };
      `,
      "tools/import-module.js": `export default {
        name: "import-module",
        description: "Tries to import a denied builtin.",
        inputSchema: {},
        async execute(input) {
          try {
            await import(input.specifier);
            return { imported: true };
          } catch (error) {
            return { imported: false, message: String(error.message) };
          }
        },
      };
      `,
      "tools/builtin.js": `export default {
        name: "builtin",
        description: "Tries both routes to a builtin: getBuiltinModule and import.",
        inputSchema: {},
        async execute(input) {
          const result = {};
          try {
            const mod = process.getBuiltinModule(input.specifier);
            result.getBuiltinModule = mod ? "OBTAINED" : "undefined";
          } catch (error) {
            result.getBuiltinModule = "denied: " + String(error.message);
          }
          try {
            await import(input.specifier);
            result.import = "OBTAINED";
          } catch (error) {
            result.import = "denied: " + String(error.message);
          }
          return result;
        },
      };
      `,
      "tools/use-allowed.js": `export default {
        name: "use-allowed",
        description: "Imports every allowed builtin and actually uses it.",
        inputSchema: {},
        async execute(input, api) {
          const path = await import("node:path");
          const crypto = await import("node:crypto");
          const zlib = await import("node:zlib");
          const util = await import("node:util");
          const buffer = await import("node:buffer");
          const events = await import("node:events");
          const stream = await import("node:stream");
          const assert = await import("node:assert");
          const querystring = await import("node:querystring");
          const stringDecoder = await import("node:string_decoder");
          const url = await import("node:url");
          const timers = await import("node:timers/promises");
          const fsp = await import("node:fs/promises");
          const gzip = await util.promisify(zlib.gzip)(Buffer.from("hello"));
          await timers.setTimeout(1);
          await fsp.writeFile(path.join(api.stateDir, "allowed.txt"), "ok");
          assert.ok(true);
          return {
            joined: path.join("a", "b"),
            hashed: crypto.createHash("sha256").update("x").digest("hex").slice(0, 8),
            gzipped: gzip.length > 0,
            bufferOk: buffer.Buffer.from("hi").toString() === "hi",
            emitterOk: typeof events.EventEmitter === "function",
            streamOk: typeof stream.Readable === "function",
            queryOk: querystring.stringify({ a: 1 }) === "a=1",
            decoderOk: typeof stringDecoder.StringDecoder === "function",
            urlOk: new url.URL("https://example.com/").hostname === "example.com",
            wroteState: await fsp.readFile(path.join(api.stateDir, "allowed.txt"), "utf-8"),
          };
        },
      };
      `,
      "tools/native-binding.js": `export default {
        name: "native-binding",
        description: "Tries the deprecated native binding back doors.",
        inputSchema: {},
        execute() {
          const result = {};
          for (const name of ["binding", "_linkedBinding"]) {
            try {
              process[name]("tcp_wrap");
              result[name] = "OBTAINED";
            } catch (error) {
              result[name] = "denied: " + String(error.message);
            }
          }
          return result;
        },
      };
      `,
      "tools/relock.js": `export default {
        name: "relock",
        description: "Tries to put the original getBuiltinModule back.",
        inputSchema: {},
        execute() {
          const result = {};
          try {
            Object.defineProperty(process, "getBuiltinModule", {
              value: () => "pwned",
            });
            result.redefined = String(process.getBuiltinModule("node:net"));
          } catch (error) {
            result.redefined = "locked";
          }
          try {
            process.getBuiltinModule = () => "pwned";
            result.reassigned = String(process.getBuiltinModule("node:net"));
          } catch (error) {
            result.reassigned = "locked";
          }
          return result;
        },
      };
      `,
      "tools/connect.js": `export default {
        name: "connect",
        description: "Tries every route to a TCP socket, then tries to use it.",
        inputSchema: {},
        async execute() {
          let net;
          const tried = [];
          // Every route the three adversarial reviews used, in order.
          for (const id of ["node:net", "net", "_tls_wrap", "_http_client", "node:_http_client"]) {
            try {
              const mod = process.getBuiltinModule(id);
              if (mod) { net = mod; tried.push(id + ":getBuiltinModule"); break; }
            } catch (error) { tried.push(id + ":gbm-denied"); }
            try {
              const mod = await import(id);
              if (mod) { net = mod.default ?? mod; tried.push(id + ":import"); break; }
            } catch (error) { tried.push(id + ":import-denied"); }
          }
          if (!net) {
            return { connected: false, stage: "module", tried, message: "plugin module denied" };
          }
          if (typeof net.connect !== "function") {
            return { connected: false, stage: "module", tried, message: "plugin module denied: no connect" };
          }
          return await new Promise((resolve) => {
            try {
              const socket = net.connect({ host: "1.1.1.1", port: 80 });
              const done = (r) => {
                try { socket.destroy(); } catch {}
                resolve(r);
              };
              socket.on("connect", () => done({ connected: true, stage: "socket" }));
              socket.on("error", (e) => done({ connected: false, stage: "socket", code: e.code }));
              setTimeout(() => done({ connected: false, stage: "timeout" }), 3000);
            } catch (error) {
              resolve({ connected: false, stage: "throw", message: String(error.message) });
            }
          });
        },
      };
      `,
      "tools/globals.js": `export default {
        name: "globals",
        description: "Reports which network globals survive.",
        inputSchema: {},
        execute() {
          return {
            fetch: typeof globalThis.fetch,
            WebSocket: typeof globalThis.WebSocket,
            XMLHttpRequest: typeof globalThis.XMLHttpRequest,
            EventSource: typeof globalThis.EventSource,
          };
        },
      };
      `,
    };

    async function hardenedHost(): Promise<PluginHost> {
      const descriptor = await writePlugin(
        "contained-plugin",
        ["tools:register"],
        PROBE_TOOLS,
      );
      const host = new PluginHost({
        descriptor,
        grantedCapabilities: ["tools:register"],
        netDomains: [],
        handlers: {},
        hardened: true,
        nodeExecutable: node.path,
      });
      running.push(host);
      await host.start();
      return host;
    }

    function output(outcome: { ok: boolean }): Record<string, unknown> {
      if (!("output" in outcome)) {
        throw new Error("tool call failed");
      }
      return (outcome as { output: Record<string, unknown> }).output;
    }

    test("starts under the permission model and registers its tools", async () => {
      const host = await hardenedHost();
      expect(host.state).toBe("running");
    });

    test("cannot read a file outside the plugin directory", async () => {
      const host = await hardenedHost();

      const result = output(await host.invokeTool("read-outside", {}));

      expect(result.read).toBe(false);
      expect(result.code).toBe("ERR_ACCESS_DENIED");
      // Emphatically: no file contents came back as data.
      expect(result.length).toBeUndefined();
    });

    test("can read its own files", async () => {
      const host = await hardenedHost();

      const result = output(await host.invokeTool("read-own", {}));

      expect(result.name).toBe("contained-plugin");
    });

    test("can write inside its state directory", async () => {
      const host = await hardenedHost();

      const result = output(await host.invokeTool("write-state", {}));

      expect(result.readBack).toBe("persisted");
      expect(result.stateDir).toBe(host.pluginStateDir);
      const onDisk = await readFile(
        path.join(host.pluginStateDir, "scratch.txt"),
        "utf-8",
      );
      expect(onDisk).toBe("persisted");
    });

    test("cannot write outside its state directory", async () => {
      const host = await hardenedHost();

      const result = output(await host.invokeTool("write-outside", {}));

      expect(result.wrote).toBe(false);
      expect(result.code).toBe("ERR_ACCESS_DENIED");
    });

    test("cannot import child_process, worker_threads, or the network builtins", async () => {
      const host = await hardenedHost();

      for (const specifier of [
        "node:child_process",
        "node:worker_threads",
        "node:net",
        "node:http",
        "node:https",
        "node:dns",
        "node:tls",
        "node:vm",
        "node:module",
        "child_process",
        "net",
      ]) {
        const result = output(
          await host.invokeTool("import-module", { specifier }),
        );
        expect(result.imported).toBe(false);
        expect(String(result.message)).toContain("plugin module denied");
      }
    });

    test("refuses every non-allowlisted builtin by BOTH routes and BOTH forms", async () => {
      const host = await hardenedHost();

      for (const specifier of [
        // Named network and process modules.
        "node:net",
        "net",
        "node:http",
        "node:https",
        "node:http2",
        "node:dns",
        "node:tls",
        "node:dgram",
        "node:child_process",
        "child_process",
        "node:module",
        "node:vm",
        "node:worker_threads",
        // Not socket-capable, but pure reconnaissance: networkInterfaces()
        // hands over internal IPs and userInfo() the username, either of
        // which could later leave through a granted net:fetch domain.
        "os",
        "node:os",
        // The socket-capable INTERNALS the third review used. None were on
        // any denylist; a plugin with no net grant reached `_tls_wrap`
        // .connect and got back HTTP/1.1 200 OK.
        "_tls_wrap",
        "node:_tls_wrap",
        "_http_client",
        "node:_http_client",
        "_http_agent",
        "node:_http_agent",
        "_http_server",
        "node:_http_server",
        "_http_outgoing",
        "node:_http_outgoing",
        "_http_common",
        "node:_http_common",
        "_stream_wrap",
      ]) {
        const result = output(await host.invokeTool("builtin", { specifier }));
        expect(String(result.getBuiltinModule)).toContain(
          "plugin module denied",
        );
        expect(String(result.import)).toContain("denied");
      }
    });

    test("refuses builtins nobody has heard of, including future ones", async () => {
      const host = await hardenedHost();

      // The whole point of an allowlist: a name this code has never seen is
      // refused without anyone having to add it to a list first.
      for (const specifier of [
        "node:some_future_builtin_2030",
        "_secret_internal",
        "node:quic",
        "node:sqlite",
        "node:test",
        "node:inspector/promises",
      ]) {
        const result = output(await host.invokeTool("builtin", { specifier }));
        expect(String(result.getBuiltinModule)).toContain(
          "plugin module denied",
        );
        expect(String(result.import)).toContain("denied");
      }
    });

    test("refuses specifiers that only look allowlisted", async () => {
      const host = await hardenedHost();

      // Normalization must fail CLOSED: no trimming, no path games.
      for (const specifier of [
        "node:fs ",
        " node:fs",
        "node:/fs",
        "node:node:fs",
        "fs/",
        "node:fs/../net",
      ]) {
        const result = output(await host.invokeTool("builtin", { specifier }));
        expect(String(result.getBuiltinModule)).toContain(
          "plugin module denied",
        );
      }
    });

    test("still allows the builtins a plugin is meant to have", async () => {
      const host = await hardenedHost();

      for (const specifier of [
        "node:fs",
        "fs",
        "node:fs/promises",
        "node:path",
        "node:crypto",
        "node:util",
        "node:zlib",
        "node:buffer",
        "node:events",
        "node:stream",
        "node:stream/promises",
        "node:timers",
        "node:timers/promises",
        "node:assert",
        "node:querystring",
        "node:string_decoder",
        "node:url",
      ]) {
        const result = output(await host.invokeTool("builtin", { specifier }));
        expect(result.getBuiltinModule).toBe("OBTAINED");
        expect(result.import).toBe("OBTAINED");
      }
    });

    test("allowed builtins actually work, not just resolve", async () => {
      const host = await hardenedHost();

      const result = output(await host.invokeTool("use-allowed", {}, 15_000));

      expect(result).toEqual({
        joined: path.join("a", "b"),
        hashed: "2d711642",
        gzipped: true,
        bufferOk: true,
        emitterOk: true,
        streamOk: true,
        queryOk: true,
        decoderOk: true,
        urlOk: true,
        wroteState: "ok",
      });
    });

    test("cannot reach native bindings through process.binding", async () => {
      const host = await hardenedHost();

      const result = output(await host.invokeTool("native-binding", {}));

      expect(String(result.binding)).toContain("plugin module denied");
      expect(String(result._linkedBinding)).toContain("plugin module denied");
    });

    test("cannot put the original getBuiltinModule back", async () => {
      const host = await hardenedHost();

      const result = output(await host.invokeTool("relock", {}));

      expect(result).toEqual({ redefined: "locked", reassigned: "locked" });
    });

    test("cannot open a TCP socket", async () => {
      const host = await hardenedHost();

      const result = output(await host.invokeTool("connect", {}, 10_000));

      expect(result.connected).toBe(false);
      // It never even got a module to call connect on — via any of the five
      // routes, including the `_tls_wrap` one that worked on Node 22.21.1.
      expect(result.stage).toBe("module");
      expect(String(result.message)).toContain("plugin module denied");
      expect(String(result.tried)).toContain("_tls_wrap:gbm-denied");
    });

    test("has no network globals at all", async () => {
      const host = await hardenedHost();

      const result = output(await host.invokeTool("globals", {}));

      expect(result).toEqual({
        fetch: "undefined",
        WebSocket: "undefined",
        XMLHttpRequest: "undefined",
        EventSource: "undefined",
      });
    });

    test("refuses to start a plugin that ships a symlink out of its tree", async () => {
      const descriptor = await writePlugin(
        "linked-plugin",
        ["tools:register"],
        {
          "tools/echo.js": ECHO_TOOL,
        },
      );
      await symlink("/", path.join(descriptor.rootDir, "escape"));
      const host = new PluginHost({
        descriptor,
        grantedCapabilities: ["tools:register"],
        netDomains: [],
        handlers: {},
        hardened: true,
        nodeExecutable: node.path,
      });
      running.push(host);

      await expect(host.start()).rejects.toThrow(/symbolic link/);
      expect(host.state).toBe("crashed");
    });
  });
}

/**
 * Drives `worker-preload.ts` directly, without a PluginHost.
 *
 * The host now REFUSES to run a hardened worker on Node < 24, so the full
 * containment suite cannot run on the 22.x tier. That must not mean the
 * in-process allowlist goes untested there: 22.x is precisely where it would
 * be the only barrier if the floor were ever lowered or bypassed. So the
 * preload is exercised directly on every tier, with the same probes.
 */
function runPreloadProbe(
  node: NodeCandidate,
  script: string,
): Record<string, string> {
  const probeDir = realpathSync(mkdtempSync(path.join(tmpdir(), "preload-")));
  try {
    const probeFile = path.join(probeDir, "probe.mjs");
    writeFileSync(probeFile, script);
    const stdout = execFileSync(
      node.path,
      [
        "--permission",
        `--allow-fs-read=${path.join(probeDir, "*")}`,
        `--allow-fs-read=${path.join(realpathSync(import.meta.dirname), "*")}`,
        "--import",
        workerPreloadPath,
        probeFile,
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const lastLine = stdout.trim().split("\n").at(-1) ?? "{}";
    return JSON.parse(lastLine) as Record<string, string>;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

const PROBE_SCRIPT = `
const out = {};
const denied = ${JSON.stringify([
  "net",
  "node:net",
  "child_process",
  "node:child_process",
  "node:module",
  "node:worker_threads",
  "node:vm",
  "_tls_wrap",
  "node:_tls_wrap",
  "_http_client",
  "node:_http_client",
  "_http_agent",
  "node:_http_agent",
  "_http_server",
  "node:_http_server",
  "_http_outgoing",
  "node:_http_outgoing",
  "_http_common",
  "node:_http_common",
  "_stream_wrap",
  "os",
  "node:os",
  "node:some_future_builtin_2030",
  "node:fs ",
  "node:/fs",
  "node:node:fs",
])};
const allowed = ${JSON.stringify([
  "node:fs",
  "node:fs/promises",
  "node:path",
  "node:crypto",
  "node:util",
  "node:zlib",
  "node:buffer",
  "node:events",
  "node:stream",
  "node:timers/promises",
  "node:assert",
  "node:querystring",
  "node:string_decoder",
  "node:url",
])};
for (const id of denied) {
  let viaGet = "denied";
  try { if (process.getBuiltinModule(id)) viaGet = "OBTAINED"; } catch {}
  let viaImport = "denied";
  try { if (await import(id)) viaImport = "OBTAINED"; } catch {}
  out["denied:" + id] = viaGet + "/" + viaImport;
}
for (const id of allowed) {
  let viaGet = "denied";
  try { if (process.getBuiltinModule(id)) viaGet = "OBTAINED"; } catch {}
  let viaImport = "denied";
  try { if (await import(id)) viaImport = "OBTAINED"; } catch {}
  out["allowed:" + id] = viaGet + "/" + viaImport;
}
out.fetch = typeof globalThis.fetch;
try { process.binding("tcp_wrap"); out.binding = "OBTAINED"; } catch { out.binding = "denied"; }
console.log(JSON.stringify(out));
`;

function describePreloadDirectly(label: string, node: NodeCandidate): void {
  describe(`worker preload allowlist (${label}, Node ${node.version})`, () => {
    test("denies every non-allowlisted builtin by both routes", () => {
      const result = runPreloadProbe(node, PROBE_SCRIPT);

      for (const [key, value] of Object.entries(result)) {
        if (key.startsWith("denied:")) {
          expect(`${key} => ${value}`).toBe(`${key} => denied/denied`);
        }
      }
      expect(result.binding).toBe("denied");
      expect(result.fetch).toBe("undefined");
    });

    test("allows every allowlisted builtin by both routes", () => {
      const result = runPreloadProbe(node, PROBE_SCRIPT);

      for (const [key, value] of Object.entries(result)) {
        if (key.startsWith("allowed:")) {
          expect(`${key} => ${value}`).toBe(`${key} => OBTAINED/OBTAINED`);
        }
      }
    });
  });
}

// The in-process allowlist is verified on EVERY tier, including the 22.x one
// the host will not run hardened.
if (legacyNode) {
  describePreloadDirectly("Node 22.x, no socket gate", legacyNode);
} else {
  warnMissingTier("Node 22.x (preload allowlist)");
}

if (modernNode) {
  describePreloadDirectly("Node >= 24, socket gate", modernNode);
  // The full containment suite needs a runtime the host will actually run.
  describeContainment("Node >= 24, socket gate", modernNode);
} else {
  warnMissingTier("Node >= 24 (full containment suite)");
}

const describeFloor = legacyNode ? describe : describe.skip;

describeFloor("hardened Node floor", () => {
  test("refuses to start a hardened worker on Node 22.x", async () => {
    const descriptor = await writePlugin("floor-plugin", ["tools:register"], {
      "tools/echo.js": ECHO_TOOL,
    });
    const host = new PluginHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
      netDomains: [],
      handlers: {},
      hardened: true,
      nodeExecutable: legacyNode?.path,
    });
    running.push(host);

    const error = await host.start().then(
      () => undefined,
      (thrown: unknown) => thrown as Error,
    );

    // The error has to be actionable: what was found, what is needed, and
    // which knob fixes it.
    expect(error?.message).toMatch(/reports major version 22/);
    expect(error?.message).toMatch(/requires Node >= 24/);
    expect(error?.message).toMatch(/nodeExecutable/);
    expect(host.state).toBe("crashed");
  });
});

describe("hardened Node floor, unusable runtimes", () => {
  test("refuses a runtime whose version cannot be read", async () => {
    const descriptor = await writePlugin(
      "unknown-runtime",
      ["tools:register"],
      {
        "tools/echo.js": ECHO_TOOL,
      },
    );
    const host = new PluginHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
      netDomains: [],
      handlers: {},
      hardened: true,
      nodeExecutable: "/nonexistent/not-a-runtime",
    });
    running.push(host);

    const error = await host.start().then(
      () => undefined,
      (thrown: unknown) => thrown as Error,
    );

    expect(error?.message).toMatch(/could not determine the version/);
    expect(error?.message).toMatch(/requires Node >= 24/);
    expect(error?.message).toMatch(/nodeExecutable/);
    expect(host.state).toBe("crashed");
  });

  test("refuses bun, which reports its own major version", async () => {
    const descriptor = await writePlugin("bun-runtime", ["tools:register"], {
      "tools/echo.js": ECHO_TOOL,
    });
    const host = new PluginHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
      netDomains: [],
      handlers: {},
      hardened: true,
      // process.execPath under `bun test` is bun itself.
      nodeExecutable: process.execPath,
    });
    running.push(host);

    await expect(host.start()).rejects.toThrow(/requires Node >= 24/);
    expect(host.state).toBe("crashed");
  });
});

if (!(legacyNode || modernNode)) {
  warnMissingTier("any Node with --permission");
}

describe("worker script resolution", () => {
  test("resolves to a directory that really holds both worker scripts", () => {
    // The whole point. A path that resolves but does not exist is the failure
    // mode that survives a green build and breaks every plugin at runtime.
    expect(existsSync(workerEntryPath)).toBe(true);
    expect(existsSync(workerPreloadPath)).toBe(true);
    expect(path.basename(workerEntryPath)).toBe("worker-entry.ts");
    expect(path.basename(workerPreloadPath)).toBe("worker-preload.ts");
  });

  test("does not throw when a bundler has erased import.meta.dirname", () => {
    // This is the regression. `path.join(undefined, "worker-entry.ts")` threw
    // a TypeError while the module was being evaluated, and `next build`
    // evaluates every route module to collect its page config — so the build
    // died on whichever route reached this package first.
    expect(() =>
      resolvePluginHostDir({ moduleDir: undefined, cwd: "/nowhere-at-all" }),
    ).not.toThrow();
    expect(
      resolvePluginHostDir({ moduleDir: undefined, cwd: "/nowhere-at-all" }),
    ).toEndWith(path.join("node_modules", "@paco", "plugin-host"));
  });

  test("finds the installed package from the working directory alone", () => {
    // `next dev`, `next start` and the `.deb` all run with the web app as the
    // working directory and this package under its `node_modules` — which is
    // the only signal left once bundling has erased `import.meta.dirname`.
    const webDir = path.join(
      realpathSync(import.meta.dirname),
      "..",
      "..",
      "apps",
      "web",
    );
    const resolved = resolvePluginHostDir({
      moduleDir: undefined,
      cwd: webDir,
      override: undefined,
    });

    expect(existsSync(path.join(resolved, "worker-entry.ts"))).toBe(true);
    expect(realpathSync(resolved)).toBe(realpathSync(import.meta.dirname));
  });

  test("climbs to an installed copy from a bundled chunk's own directory", () => {
    const chunkDir = path.join(
      realpathSync(import.meta.dirname),
      "..",
      "..",
      "apps",
      "web",
      ".next",
      "server",
      "chunks",
    );
    const resolved = resolvePluginHostDir({
      moduleDir: chunkDir,
      cwd: "/nowhere-at-all",
      override: undefined,
    });

    expect(realpathSync(resolved)).toBe(realpathSync(import.meta.dirname));
  });

  test("an explicit override wins over everything else", () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "host-dir-")));
    try {
      writeFileSync(path.join(dir, "worker-entry.ts"), "");
      expect(resolvePluginHostDir({ override: dir })).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an override that does not hold the scripts is ignored, not obeyed", () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "host-dir-")));
    try {
      // Falls through to the real package rather than handing `spawn` a
      // directory with nothing in it.
      const resolved = resolvePluginHostDir({ override: dir });
      expect(resolved).not.toBe(dir);
      expect(existsSync(path.join(resolved, "worker-entry.ts"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * `SECURITY.md` promises the worker gets "no subprocesses, threads, or native
 * code". Nothing implements that promise: it holds only because
 * `buildWorkerArgv` does not pass `--allow-child-process`, `--allow-worker` or
 * `--allow-addons`. An absence is invisible in review and survives exactly as
 * long as nobody appends a flag — so it is asserted here, by scanning the argv
 * for anything that grants one of them rather than by pinning the array, which
 * would fail on a harmless reordering and teach people to re-bless it.
 */
describe("hardened worker argv", () => {
  const FORBIDDEN_GRANTS = [
    "--allow-child-process",
    "--allow-worker",
    "--allow-addons",
    "--allow-wasi",
    "--allow-net",
  ];

  function argv(): string[] {
    return buildWorkerArgv({
      hardened: true,
      readableDirs: ["/plugin/root", "/pkg/dir", "/state/dir"],
      writableDir: "/state/dir",
      preloadPath: "/pkg/dir/worker-preload.ts",
      entryPath: "/pkg/dir/worker-entry.ts",
    });
  }

  test("grants nothing that would let a plugin execute code outside its process", () => {
    for (const flag of argv()) {
      const granted = FORBIDDEN_GRANTS.find(
        (forbidden) => flag === forbidden || flag.startsWith(`${forbidden}=`),
      );
      expect(
        granted === undefined
          ? "no forbidden permission granted"
          : `argv grants ${granted} — SECURITY.md promises the worker cannot spawn processes, threads or native code`,
      ).toBe("no forbidden permission granted");
    }
  });

  test("turns the permission model on and allows exactly the intended paths", () => {
    const args = argv();

    // Without `--permission` every `--allow-*` below is inert and the worker
    // runs with the full filesystem.
    expect(args).toContain("--permission");
    expect(args.filter((arg) => arg.startsWith("--allow-fs-read="))).toEqual([
      `--allow-fs-read=${path.join("/plugin/root", "*")}`,
      `--allow-fs-read=${path.join("/pkg/dir", "*")}`,
      `--allow-fs-read=${path.join("/state/dir", "*")}`,
    ]);
    // Exactly one writable path, and it is the per-plugin scratch dir.
    expect(args.filter((arg) => arg.startsWith("--allow-fs-write="))).toEqual([
      `--allow-fs-write=${path.join("/state/dir", "*")}`,
    ]);
    // The preload is what closes the network inside the process; it has to be
    // the argument to `--import`, and the entry has to be last.
    expect(args.at(-3)).toBe("--import");
    expect(args.at(-2)).toBe("/pkg/dir/worker-preload.ts");
    expect(args.at(-1)).toBe("/pkg/dir/worker-entry.ts");
  });

  test("the unhardened argv is the entry alone, with no permission flags", () => {
    // `hardened: false` removes the sandbox entirely — it must not look like a
    // weaker sandbox, which would be worse than none.
    expect(
      buildWorkerArgv({
        hardened: false,
        readableDirs: ["/plugin/root"],
        writableDir: "/state/dir",
        preloadPath: "/pkg/dir/worker-preload.ts",
        entryPath: "/pkg/dir/worker-entry.ts",
      }),
    ).toEqual(["/pkg/dir/worker-entry.ts"]);
  });
});
