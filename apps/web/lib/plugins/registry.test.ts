import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { PluginManifest } from "@paco/plugin-kit";
import type { PluginRow } from "@/lib/db/schema";

mock.module("server-only", () => ({}));

type StartResult = { tools: [] };
let startBehavior: (id: string) => Promise<StartResult>;
let startedIds: string[];
let stoppedIds: string[];

class FakePluginHost {
  static instances: FakePluginHost[] = [];
  id: string;
  constructor(options: { descriptor: { manifest: { name: string } } }) {
    this.id = options.descriptor.manifest.name;
    FakePluginHost.instances.push(this);
  }
  async start(): Promise<StartResult> {
    startedIds.push(this.id);
    return await startBehavior(this.id);
  }
  async stop(): Promise<void> {
    stoppedIds.push(this.id);
  }
}

mock.module("@paco/plugin-host", () => ({ PluginHost: FakePluginHost }));

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
let integrityBehavior: (id: string, contentHash: string) => Promise<IntegrityResult>;

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
  startPluginHost,
  stopPluginHost,
} = await import("./registry.ts");

function row(id: string, enabled = true): PluginRow {
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
      capabilities: [],
    } as PluginManifest,
    grantedCapabilities: [],
    consentedNetDomains: [],
    enabled,
    installedAt: new Date(),
    updatedAt: new Date(),
  };
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & {
      __pacoPluginRegistry?: unknown;
      __pacoPluginStartLocks?: unknown;
    }
  ).__pacoPluginRegistry = undefined;
  (
    globalThis as typeof globalThis & {
      __pacoPluginRegistry?: unknown;
      __pacoPluginStartLocks?: unknown;
    }
  ).__pacoPluginStartLocks = undefined;

  FakePluginHost.instances = [];
  startedIds = [];
  stoppedIds = [];
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
});
