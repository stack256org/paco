import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Capability, PluginDescriptor } from "@paco/plugin-kit";
import { discoverPlugin } from "@paco/plugin-kit";
import {
  type CapabilityHandlers,
  type HostLogEntry,
  PluginHost,
} from "./host.ts";

let rootDir: string;
const running: PluginHost[] = [];

/** Every fixture plugin root gets this so `.js` slot files load as ESM. */
const ESM_PACKAGE_JSON = JSON.stringify({ type: "module" });

function manifest(name: string, capabilities: Capability[]) {
  return JSON.stringify({
    name,
    version: "1.0.0",
    description: "Fixture plugin.",
    pacoApi: 1,
    capabilities,
    ...(capabilities.includes("net:fetch")
      ? { netDomains: ["example.com"] }
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
): Promise<PluginDescriptor> {
  const pluginDir = path.join(rootDir, name);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, "plugin.json"),
    manifest(name, capabilities),
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

function makeHost(opts: {
  descriptor: PluginDescriptor;
  grantedCapabilities: Capability[];
  handlers?: CapabilityHandlers;
  logs?: HostLogEntry[];
}): PluginHost {
  const logs = opts.logs;
  const host = new PluginHost({
    descriptor: opts.descriptor,
    grantedCapabilities: opts.grantedCapabilities,
    handlers: opts.handlers ?? {},
    logger: logs ? (entry) => logs.push(entry) : undefined,
  });
  running.push(host);
  return host;
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
});

describe("PluginHost worker environment", () => {
  test("gives the worker exactly PATH and PACO_PLUGIN_ID", async () => {
    const descriptor = await writePlugin("env-plugin", ["tools:register"], {
      "tools/env.js": `export default {
        name: "env",
        description: "Reports its own environment.",
        inputSchema: {},
        execute() {
          return { keys: Object.keys(process.env), pluginId: process.env.PACO_PLUGIN_ID };
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
        ? (outcome.output as { keys: string[]; pluginId: string })
        : { keys: [], pluginId: "" };
    expect([...output.keys].sort()).toEqual(["PACO_PLUGIN_ID", "PATH"]);
    expect(output.pluginId).toBe("env-plugin");
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
  });

  test("times out a hung tool invocation and stays running", async () => {
    const descriptor = await writePlugin("slow-plugin", ["tools:register"], {
      "tools/hang.js": `export default {
        name: "hang",
        description: "Never resolves.",
        inputSchema: {},
        execute() {
          return new Promise(() => {});
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
  });

  test("fails start when the worker never becomes ready", async () => {
    const descriptor = await writePlugin("stuck-plugin", ["tools:register"], {
      "hooks/stall.js": `export default function stall() {
        return new Promise(() => {});
      };
      `,
    });
    const host = new PluginHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
      handlers: {},
      readyTimeoutMs: 300,
    });
    running.push(host);

    await expect(host.start()).rejects.toThrow(/ready/i);
    expect(host.state).toBe("crashed");
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
    const host = new PluginHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
      handlers: {},
      shutdownTimeoutMs: 300,
    });
    running.push(host);
    await host.start();

    const startedAt = Date.now();
    await host.stop();
    const elapsed = Date.now() - startedAt;

    expect(host.state).toBe("stopped");
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(3000);
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
  test("fans an event out to a subscriber when events:subscribe is granted", async () => {
    const descriptor = await writePlugin(
      "listener-plugin",
      ["tools:register", "events:subscribe"],
      {
        "hooks/listen.js": `export default function listen(api) {
          globalThis.__seen = [];
          api.events.subscribe((event) => {
            globalThis.__seen.push(event);
          });
        };
        `,
        "tools/seen.js": `export default {
          name: "seen",
          description: "Returns the events observed so far.",
          inputSchema: {},
          execute() {
            return { seen: globalThis.__seen ?? [] };
          },
        };
        `,
      },
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
    const descriptor = await writePlugin("deaf-plugin", ["tools:register"], {
      "hooks/listen.js": `export default function listen(api) {
        globalThis.__seen = [];
        api.events.subscribe((event) => {
          globalThis.__seen.push(event);
        });
      };
      `,
      "tools/seen.js": `export default {
        name: "seen",
        description: "Returns the events observed so far.",
        inputSchema: {},
        execute() {
          return { seen: globalThis.__seen ?? [] };
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

    host.deliverEvent(1, "chat-1", { type: "message" });

    const outcome = await host.invokeTool("seen", {});
    expect(outcome).toEqual({ ok: true, output: { seen: [] } });
  });
});
