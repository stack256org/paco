import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Capability, PluginManifest } from "@paco/plugin-kit";
import type { PluginRow } from "@/lib/db/schema";

mock.module("server-only", () => ({}));

type FakeTool = { name: string; description: string; inputSchema: unknown };
type StartResult = { tools: FakeTool[] };
let startBehavior: (id: string) => Promise<StartResult>;
let startedIds: string[];
let stoppedIds: string[];

type FakeHostState = "starting" | "running" | "crashed" | "stopped";

class FakePluginHost {
  static instances: FakePluginHost[] = [];
  id: string;
  state: FakeHostState = "starting";
  private readonly crashCallbacks: Array<(error: string) => void> = [];
  constructor(options: { descriptor: { manifest: { name: string } } }) {
    this.id = options.descriptor.manifest.name;
    FakePluginHost.instances.push(this);
  }
  onCrash(callback: (error: string) => void): void {
    this.crashCallbacks.push(callback);
  }
  async start(): Promise<StartResult> {
    startedIds.push(this.id);
    try {
      const result = await startBehavior(this.id);
      this.state = "running";
      return result;
    } catch (error) {
      this.state = "crashed";
      throw error;
    }
  }
  async stop(): Promise<void> {
    stoppedIds.push(this.id);
    this.state = "stopped";
  }
  /** Test helper: simulate a crash arriving after a successful start. */
  simulateCrash(reason: string): void {
    this.state = "crashed";
    for (const callback of this.crashCallbacks) {
      callback(reason);
    }
  }
}

mock.module("@paco/plugin-host", () => ({ PluginHost: FakePluginHost }));

let fanoutRegisterCalls: FakePluginHost[];
let fanoutUnregisterCalls: FakePluginHost[];
let fanoutStartCalls: number;
const fakeFanout = {
  register: (host: FakePluginHost) => {
    fanoutRegisterCalls.push(host);
  },
  unregister: (host: FakePluginHost) => {
    fanoutUnregisterCalls.push(host);
  },
  start: () => {
    fanoutStartCalls++;
  },
};

mock.module("@/lib/plugins/plugin-fanout", () => ({
  getPluginEventFanout: () => fakeFanout,
}));

let discoverBehavior: (
  rootDir: string,
) => Promise<
  | { ok: true; plugin: { manifest: { name: string }; rootDir: string } }
  | { ok: false; error: string }
>;

mock.module("@paco/plugin-kit", () => ({
  discoverPlugin: (rootDir: string) => discoverBehavior(rootDir),
}));

type IntegrityResult = { ok: true } | { ok: false; error: string };
let integrityBehavior: (
  id: string,
  contentHash: string,
) => Promise<IntegrityResult>;

mock.module("@/lib/plugins/install", () => ({
  pluginDir: (id: string) => `/plugins/${id}`,
  recheckPluginIntegrity: (id: string, contentHash: string) =>
    integrityBehavior(id, contentHash),
}));

mock.module("@/lib/plugins/capability-handlers", () => ({
  buildCapabilityHandlers: () => ({}),
}));

let rows: PluginRow[];
let listPluginsBehavior: () => Promise<PluginRow[]>;
mock.module("@/lib/db/plugins", () => ({
  listPlugins: () => listPluginsBehavior(),
  getPlugin: (id: string) =>
    Promise.resolve(rows.find((candidate) => candidate.id === id)),
}));

const {
  ensurePluginsStarted,
  getPluginRegistry,
  listEnabledPluginsForMcp,
  startPluginHost,
  stopPluginHost,
} = await import("./registry.ts");

function row(
  id: string,
  enabled = true,
  grantedCapabilities: Capability[] = ["tools:register"],
): PluginRow {
  return {
    id,
    source: "local:/tmp",
    version: "1.0.0",
    contentHash: "hash",
    manifest: {
      name: id,
      version: "1.0.0",
      description: "d",
      pacoApi: 1,
      capabilities: ["tools:register"],
    } as PluginManifest,
    grantedCapabilities,
    consentedNetDomains: [],
    enabled,
    ingressSecret: null,
    installedAt: new Date(),
    updatedAt: new Date(),
  };
}

function resetGlobalRegistryState(): void {
  const globalForTest = globalThis as typeof globalThis & {
    __pacoPluginRegistry?: unknown;
    __pacoPluginStartLocks?: unknown;
    __pacoPluginTools?: unknown;
    __pacoPluginRestartAttempts?: unknown;
  };
  globalForTest.__pacoPluginRegistry = undefined;
  globalForTest.__pacoPluginStartLocks = undefined;
  globalForTest.__pacoPluginTools = undefined;
  globalForTest.__pacoPluginRestartAttempts = undefined;
}

beforeEach(() => {
  resetGlobalRegistryState();

  FakePluginHost.instances = [];
  startedIds = [];
  stoppedIds = [];
  fanoutRegisterCalls = [];
  fanoutUnregisterCalls = [];
  fanoutStartCalls = 0;
  rows = [];
  listPluginsBehavior = async () => rows;
  startBehavior = async () => ({ tools: [] });
  integrityBehavior = async () => ({ ok: true });
  discoverBehavior = async (rootDir) => ({
    ok: true,
    plugin: {
      manifest: { name: rootDir.split("/").pop() ?? "unknown" },
      rootDir,
    },
  });
});

describe("ensurePluginsStarted", () => {
  test("starts a host for every enabled plugin and registers it", async () => {
    rows = [row("plugin-a"), row("plugin-b")];

    await ensurePluginsStarted();

    const registry = getPluginRegistry();
    expect([...registry.keys()].sort()).toEqual(["plugin-a", "plugin-b"]);
    expect(startedIds.sort()).toEqual(["plugin-a", "plugin-b"]);
  });

  test("skips disabled plugins", async () => {
    rows = [row("plugin-a", true), row("plugin-b", false)];

    await ensurePluginsStarted();

    expect([...getPluginRegistry().keys()]).toEqual(["plugin-a"]);
  });

  test("does not start a plugin already in the registry", async () => {
    rows = [row("plugin-a")];
    await ensurePluginsStarted();
    expect(startedIds).toEqual(["plugin-a"]);

    // Second call: plugin-a is already registered, so it must not be
    // started again even though listPlugins still reports it.
    await ensurePluginsStarted();
    expect(startedIds).toEqual(["plugin-a"]);
  });

  test("never throws when listPlugins fails", async () => {
    listPluginsBehavior = async () => {
      throw new Error("db is down");
    };

    await expect(ensurePluginsStarted()).resolves.toBeUndefined();
    expect([...getPluginRegistry().keys()]).toEqual([]);
  });

  test("logs and skips a plugin whose discovery fails, without throwing", async () => {
    rows = [row("plugin-a"), row("plugin-b")];
    discoverBehavior = async (rootDir) => {
      if (rootDir.endsWith("plugin-a")) {
        return { ok: false, error: "manifest is invalid" };
      }
      return {
        ok: true,
        plugin: { manifest: { name: "plugin-b" }, rootDir },
      };
    };

    await expect(ensurePluginsStarted()).resolves.toBeUndefined();
    expect([...getPluginRegistry().keys()]).toEqual(["plugin-b"]);
  });

  test("logs and skips a plugin whose host fails to start, without throwing", async () => {
    rows = [row("plugin-a"), row("plugin-b")];
    startBehavior = async (id) => {
      if (id === "plugin-a") {
        throw new Error("worker crashed on boot");
      }
      return { tools: [] };
    };

    await expect(ensurePluginsStarted()).resolves.toBeUndefined();
    expect([...getPluginRegistry().keys()]).toEqual(["plugin-b"]);
  });

  test("two concurrent calls do not start the same plugin twice", async () => {
    rows = [row("plugin-a")];
    const deferred = Promise.withResolvers<StartResult>();
    startBehavior = () => deferred.promise;

    const first = ensurePluginsStarted();
    const second = ensurePluginsStarted();
    deferred.resolve({ tools: [] });
    await Promise.all([first, second]);

    expect(startedIds).toEqual(["plugin-a"]);
  });
});

describe("startPluginHost", () => {
  test("starts and registers a not-yet-running plugin", async () => {
    rows = [row("plugin-a")];

    const result = await startPluginHost("plugin-a");

    expect(result).toEqual({ ok: true });
    expect(getPluginRegistry().has("plugin-a")).toBe(true);
    expect(startedIds).toEqual(["plugin-a"]);
  });

  test("is a no-op — and does not re-start — when already registered", async () => {
    rows = [row("plugin-a")];
    await startPluginHost("plugin-a");
    expect(startedIds).toEqual(["plugin-a"]);

    const result = await startPluginHost("plugin-a");

    expect(result).toEqual({ ok: true });
    expect(startedIds).toEqual(["plugin-a"]);
  });

  test("returns a not-found error for a plugin with no row, without throwing", async () => {
    rows = [];

    const result = await startPluginHost("missing-plugin");

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/No plugin installed/);
    expect(getPluginRegistry().has("missing-plugin")).toBe(false);
  });

  test("surfaces a host start failure, including the Node-floor message, verbatim — and never throws", async () => {
    rows = [row("plugin-a")];
    const nodeFloorMessage =
      "plugin plugin-a cannot start: the runtime at /usr/bin/node reports major version 18, but a hardened plugin worker requires Node >= 24. Point the `nodeExecutable` option at a Node >= 24 binary.";
    startBehavior = async () => {
      throw new Error(nodeFloorMessage);
    };

    const result = await startPluginHost("plugin-a");

    expect(result).toEqual({ ok: false, error: nodeFloorMessage });
    expect(getPluginRegistry().has("plugin-a")).toBe(false);
  });

  test("two concurrent calls for the same plugin do not double-start it", async () => {
    rows = [row("plugin-a")];
    const deferred = Promise.withResolvers<StartResult>();
    startBehavior = () => deferred.promise;

    const first = startPluginHost("plugin-a");
    const second = startPluginHost("plugin-a");
    deferred.resolve({ tools: [] });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual({ ok: true });
    expect(secondResult).toEqual({ ok: true });
    expect(startedIds).toEqual(["plugin-a"]);
  });

  test("shares its start lock with a concurrent ensurePluginsStarted call for the same plugin", async () => {
    rows = [row("plugin-a")];
    const deferred = Promise.withResolvers<StartResult>();
    startBehavior = () => deferred.promise;

    const viaEnsure = ensurePluginsStarted();
    const viaDirect = startPluginHost("plugin-a");
    deferred.resolve({ tools: [] });
    await Promise.all([viaEnsure, viaDirect]);

    expect(startedIds).toEqual(["plugin-a"]);
  });
});

describe("content integrity", () => {
  test("starts normally when recheckPluginIntegrity reports a match", async () => {
    rows = [row("plugin-a")];
    let checked: [string, string] | undefined;
    integrityBehavior = async (id, contentHash) => {
      checked = [id, contentHash];
      return { ok: true };
    };

    const result = await startPluginHost("plugin-a");

    expect(result).toEqual({ ok: true });
    expect(checked).toEqual(["plugin-a", "hash"]);
    expect(getPluginRegistry().has("plugin-a")).toBe(true);
  });

  test("refuses to start, and never spawns a host, on a content hash mismatch", async () => {
    rows = [row("plugin-a")];
    const mismatchError =
      'Plugin "plugin-a" has changed on disk since it was installed — its content hash no longer matches what was reviewed and consented to. Reinstall it to review and re-consent to the current code before it can run.';
    integrityBehavior = async () => ({ ok: false, error: mismatchError });

    const result = await startPluginHost("plugin-a");

    expect(result).toEqual({ ok: false, error: mismatchError });
    expect(getPluginRegistry().has("plugin-a")).toBe(false);
    // Discovery/construction never ran: no host was spawned to check.
    expect(startedIds).toEqual([]);
    expect(FakePluginHost.instances).toEqual([]);
  });

  test("ensurePluginsStarted also refuses a plugin that fails its integrity check", async () => {
    rows = [row("plugin-a"), row("plugin-b")];
    integrityBehavior = async (id) =>
      id === "plugin-a"
        ? { ok: false, error: "content hash mismatch" }
        : { ok: true };

    await expect(ensurePluginsStarted()).resolves.toBeUndefined();

    expect([...getPluginRegistry().keys()]).toEqual(["plugin-b"]);
    expect(startedIds).toEqual(["plugin-b"]);
  });
});

describe("stopPluginHost", () => {
  test("stops a running host and removes it from the registry", async () => {
    rows = [row("plugin-a")];
    await startPluginHost("plugin-a");
    expect(getPluginRegistry().has("plugin-a")).toBe(true);

    await stopPluginHost("plugin-a");

    expect(getPluginRegistry().has("plugin-a")).toBe(false);
    expect(stoppedIds).toEqual(["plugin-a"]);
  });

  test("is a no-op when no host is running for that id", async () => {
    await expect(stopPluginHost("never-started")).resolves.toBeUndefined();
  });

  test("unregisters the stopped host from the session-event fan-out", async () => {
    rows = [row("plugin-a")];
    await startPluginHost("plugin-a");
    const host = FakePluginHost.instances[0] as FakePluginHost;

    await stopPluginHost("plugin-a");

    expect(fanoutUnregisterCalls).toEqual([host]);
  });
});

describe("crash restart", () => {
  test("logs a plugin/crashed line when a running host crashes", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {
      // Silence; asserted on below.
    });
    rows = [row("plugin-a")];
    await startPluginHost("plugin-a");
    const host = FakePluginHost.instances[0] as FakePluginHost;

    host.simulateCrash("worker exited unexpectedly");

    expect(errorSpy).toHaveBeenCalledWith(
      "plugin/crashed",
      expect.objectContaining({
        id: "plugin-a",
        error: "worker exited unexpectedly",
      }),
    );
    errorSpy.mockRestore();
  });

  test("restarts a crashed plugin on the next ensure, up to 3 attempts, then stays crashed", async () => {
    rows = [row("plugin-a")];
    await startPluginHost("plugin-a");
    const host = FakePluginHost.instances[0] as FakePluginHost;
    expect(host.state).toBe("running");

    host.simulateCrash("worker exited");

    // Every restart attempt from here on fails, so the plugin never leaves
    // the "crashed" state and every ensure call after the third is a no-op.
    startBehavior = async () => {
      throw new Error("still broken");
    };

    await ensurePluginsStarted(); // restart attempt 1 of 3
    await ensurePluginsStarted(); // restart attempt 2 of 3
    await ensurePluginsStarted(); // restart attempt 3 of 3
    await ensurePluginsStarted(); // must NOT attempt a 4th

    // 1 initial start + 3 restart attempts = 4 calls to start().
    expect(startedIds).toEqual([
      "plugin-a",
      "plugin-a",
      "plugin-a",
      "plugin-a",
    ]);
    expect(getPluginRegistry().get("plugin-a")?.state).toBe("crashed");
  });

  test("a successful restart resets the attempt counter for a later crash", async () => {
    rows = [row("plugin-a")];
    await startPluginHost("plugin-a");
    const firstHost = FakePluginHost.instances[0] as FakePluginHost;
    firstHost.simulateCrash("boom");

    // This restart succeeds and replaces the registry entry.
    await ensurePluginsStarted();
    expect(getPluginRegistry().get("plugin-a")?.state).toBe("running");

    const secondHost = FakePluginHost.instances.at(-1) as FakePluginHost;
    secondHost.simulateCrash("boom again");
    startBehavior = async () => {
      throw new Error("still broken");
    };

    // If the counter had NOT reset, this crash would already be out of
    // attempts. It gets its own fresh 3, so three more starts happen.
    await ensurePluginsStarted();
    await ensurePluginsStarted();
    await ensurePluginsStarted();
    await ensurePluginsStarted(); // 4th of this episode: no-op

    // 1 (initial) + 1 (successful restart) + 3 (failed restarts) = 5.
    expect(startedIds).toHaveLength(5);
    expect(getPluginRegistry().get("plugin-a")?.state).toBe("crashed");
  });

  test("does not restart a crashed plugin that has since been disabled", async () => {
    rows = [row("plugin-a")];
    await startPluginHost("plugin-a");
    const host = FakePluginHost.instances[0] as FakePluginHost;
    host.simulateCrash("boom");

    // Disabled between the crash and the next ensure — e.g. an operator
    // turned it off after seeing it crash. `needsStartAttempt`'s `enabled`
    // gate must apply to a crashed retry exactly like it does to a fresh
    // start.
    rows = [row("plugin-a", false)];
    await ensurePluginsStarted();

    expect(startedIds).toEqual(["plugin-a"]);
    expect(host.state).toBe("crashed");
  });
});

describe("session-event fan-out wiring", () => {
  test("registers a newly started host with the fan-out and starts it", async () => {
    rows = [row("plugin-a")];

    await startPluginHost("plugin-a");
    const host = FakePluginHost.instances[0] as FakePluginHost;

    expect(fanoutRegisterCalls).toEqual([host]);
    expect(fanoutStartCalls).toBeGreaterThan(0);
  });

  test("registers a restarted host again after a crash, and unregisters the crashed one it replaced", async () => {
    rows = [row("plugin-a")];
    await startPluginHost("plugin-a");
    const firstHost = FakePluginHost.instances[0] as FakePluginHost;
    firstHost.simulateCrash("boom");

    await ensurePluginsStarted();
    const secondHost = FakePluginHost.instances.at(-1) as FakePluginHost;

    expect(fanoutRegisterCalls).toEqual([firstHost, secondHost]);
    // The whole point of a successful restart: the dead host it replaced
    // must not keep polling forever inside `SessionEventFanout` — a plugin
    // that crashes and successfully restarts N times must never accumulate
    // N live registrations for one plugin id.
    expect(fanoutUnregisterCalls).toEqual([firstHost]);
  });

  test("a plugin that exhausts every restart attempt ends with zero fan-out registrations", async () => {
    rows = [row("plugin-a")];
    await startPluginHost("plugin-a");
    const host = FakePluginHost.instances[0] as FakePluginHost;
    host.simulateCrash("boom");

    // Every restart attempt fails, so the plugin is permanently crashed
    // once the third one is exhausted.
    startBehavior = async () => {
      throw new Error("still broken");
    };

    await ensurePluginsStarted(); // restart attempt 1 of 3
    expect(fanoutUnregisterCalls).toEqual([]);
    await ensurePluginsStarted(); // restart attempt 2 of 3
    expect(fanoutUnregisterCalls).toEqual([]);
    await ensurePluginsStarted(); // restart attempt 3 of 3: now exhausted
    await ensurePluginsStarted(); // 4th call: no-op, nothing left to try

    expect(getPluginRegistry().get("plugin-a")?.state).toBe("crashed");
    // A permanently-dead plugin must end with ZERO fan-out registrations —
    // not the one it started with, still sitting there forever.
    expect(fanoutRegisterCalls).toEqual([host]);
    expect(fanoutUnregisterCalls).toEqual([host]);
  });
});

describe("listEnabledPluginsForMcp", () => {
  test("returns manifest and registered tools for every enabled, running plugin", async () => {
    startBehavior = async (id) => ({
      tools:
        id === "plugin-a"
          ? [{ name: "search", description: "d", inputSchema: {} }]
          : [],
    });
    rows = [row("plugin-a"), row("plugin-b")];

    await ensurePluginsStarted();
    const enabled = await listEnabledPluginsForMcp();

    expect(enabled.map((plugin) => plugin.id).sort()).toEqual([
      "plugin-a",
      "plugin-b",
    ]);
    const pluginA = enabled.find((plugin) => plugin.id === "plugin-a");
    expect(pluginA?.tools).toEqual([
      { name: "search", description: "d", inputSchema: {} },
    ]);
    const pluginB = enabled.find((plugin) => plugin.id === "plugin-b");
    expect(pluginB?.tools).toEqual([]);

    // The operator's grants travel with the plugin, so the bridge decides
    // what to expose from the consented list rather than from the manifest.
    expect(pluginA?.grantedCapabilities).toEqual(["tools:register"]);
  });

  test("excludes a plugin whose tools:register grant the operator denied", async () => {
    // The exploit this closes: install from GitHub, deny every capability,
    // enable anyway. Nothing about a running host is consent, so a plugin
    // without the grant must not reach the CLI's --mcp-config at all.
    startBehavior = async () => ({
      tools: [{ name: "search", description: "d", inputSchema: {} }],
    });
    rows = [row("plugin-a", true, [])];

    await ensurePluginsStarted();

    expect(await listEnabledPluginsForMcp()).toEqual([]);
  });

  test("excludes a plugin granted other capabilities but not tools:register", async () => {
    rows = [row("plugin-a", true, ["storage:kv", "events:subscribe"])];

    await ensurePluginsStarted();

    expect(await listEnabledPluginsForMcp()).toEqual([]);
  });

  test("is empty when no plugin has ever been started", async () => {
    rows = [row("plugin-a")];

    expect(await listEnabledPluginsForMcp()).toEqual([]);
  });

  test("excludes a disabled plugin even though its row still exists", async () => {
    rows = [row("plugin-a")];
    await startPluginHost("plugin-a");
    rows = [row("plugin-a", false)];

    expect(await listEnabledPluginsForMcp()).toEqual([]);
  });

  test("excludes a plugin whose host has crashed", async () => {
    rows = [row("plugin-a")];
    await startPluginHost("plugin-a");
    const host = FakePluginHost.instances[0] as FakePluginHost;
    host.simulateCrash("boom");

    expect(await listEnabledPluginsForMcp()).toEqual([]);
  });
});
