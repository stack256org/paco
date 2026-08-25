import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Capability, PluginDescriptor } from "@paco/plugin-kit";
import { discoverPlugin } from "@paco/plugin-kit";
import { type CapabilityHandlers, PluginHost } from "./host.ts";

/**
 * Covers the `storage:kv` namespace of the plugin-facing API
 * (`plugin-api.ts` + `worker-entry.ts`'s `kv` wrapper) against a handler
 * that behaves the way the production one does
 * (`apps/web/lib/plugins/capability-handlers.ts`).
 *
 * This exists because the wrapper and the handler had silently disagreed:
 * `PluginKvApi.list` was declared `list(prefix?): Promise<string[]>` and the
 * worker coerced whatever came back into an array of strings, while the
 * handler has always been keyset-paginated and returns
 * `{ items: [{key, value}], nextAfterKey? }`. Every plugin calling
 * `kv.list()` therefore got an empty array. Nothing caught it, because the
 * handler's own tests only ever called the handler directly — never through
 * a real worker — so the two sides were never exercised together. That is
 * what these tests do: a real worker process, over the real protocol.
 */

let rootDir: string;
const running: PluginHost[] = [];

const ESM_PACKAGE_JSON = JSON.stringify({ type: "module" });

function manifest(name: string, capabilities: Capability[]) {
  return JSON.stringify({
    name,
    version: "1.0.0",
    description: "Fixture plugin.",
    pacoApi: 1,
    capabilities,
  });
}

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

/** Non-hardened for the same reason as the sibling suites: `bun test` has no permission model. */
function makeHost(options: {
  descriptor: PluginDescriptor;
  grantedCapabilities: Capability[];
  handlers?: CapabilityHandlers;
}): PluginHost {
  const host = new PluginHost({
    descriptor: options.descriptor,
    grantedCapabilities: options.grantedCapabilities,
    netDomains: [],
    handlers: options.handlers ?? {},
    hardened: false,
  });
  running.push(host);
  return host;
}

/**
 * An in-memory stand-in for the real `storage:kv` handler, deliberately
 * mirroring its contract rather than simplifying it: ordered by key, capped
 * at `PAGE_LIMIT` rows, `afterKey` exclusive, and `nextAfterKey` set iff the
 * page came back full. A simplification here would let the wrapper drift
 * from production again without failing.
 */
const PAGE_LIMIT = 3;

function isFakeSealed(value: unknown): value is { __fakeSealed: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { __fakeSealed?: unknown }).__fakeSealed === "string"
  );
}

function makeKvHandler(store: Map<string, unknown>): CapabilityHandlers {
  return {
    "storage:kv": (_pluginId, payload) => {
      const op = payload as {
        op: string;
        key?: string;
        value?: unknown;
        afterKey?: string;
      };
      switch (op.op) {
        case "get": {
          const stored = store.get(op.key ?? "") ?? null;
          if (isFakeSealed(stored)) {
            return Promise.resolve(
              Buffer.from(stored.__fakeSealed, "base64").toString("utf-8"),
            );
          }
          return Promise.resolve(stored);
        }
        case "set":
          store.set(op.key ?? "", op.value);
          return Promise.resolve({ ok: true });
        case "setSecret":
          // Stands in for the real handler's `seal()`: what matters here is
          // that the worker sends a distinct op with the plaintext, and that
          // `get` gives the plaintext back.
          store.set(op.key ?? "", {
            __fakeSealed: Buffer.from(String(op.value), "utf-8").toString(
              "base64",
            ),
          });
          return Promise.resolve({ ok: true });
        case "delete":
          store.delete(op.key ?? "");
          return Promise.resolve({ ok: true });
        case "list": {
          const keys = [...store.keys()]
            .sort()
            .filter((key) => (op.afterKey ? key > op.afterKey : true));
          const page = keys.slice(0, PAGE_LIMIT);
          const result: {
            items: Array<{ key: string; value: unknown }>;
            nextAfterKey?: string;
          } = {
            items: page.map((key) => {
              const stored = store.get(key);
              return isFakeSealed(stored)
                ? { key, value: null, secret: true }
                : { key, value: stored };
            }),
          };
          if (page.length === PAGE_LIMIT) {
            result.nextAfterKey = page.at(-1);
          }
          return Promise.resolve(result);
        }
        default:
          return Promise.reject(new Error(`unknown op: ${op.op}`));
      }
    },
  };
}

/**
 * Walks every page exactly as a real plugin would, and returns what it saw
 * — so the assertions below are about what plugin code actually receives,
 * not about the protocol frame.
 */
const KV_TOOL = `
  export default {
    name: "kv-probe",
    description: "Exercises the kv namespace.",
    inputSchema: { type: "object", properties: {} },
    async execute(input, api) {
      if (input.seed) {
        for (const key of input.seed) {
          await api.kv.set(key, { at: key });
        }
      }

      const pages = [];
      let afterKey;
      do {
        const page = await api.kv.list(afterKey);
        pages.push(page);
        afterKey = page.nextAfterKey;
      } while (afterKey);

      return {
        pages,
        // Proves the declared shape reached plugin code: an array-of-strings
        // return (the old, broken contract) has neither of these.
        firstPageIsObject: !Array.isArray(pages[0]),
        allKeys: pages.flatMap((page) => page.items.map((item) => item.key)),
        firstValue: pages[0].items[0]?.value ?? null,
      };
    },
  };
`;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "plugin-kv-"));
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((host) => host.stop()));
  await rm(rootDir, { recursive: true, force: true });
});

describe("storage:kv through a real worker", () => {
  async function runProbe(store: Map<string, unknown>, seed: string[]) {
    const descriptor = await writePlugin(
      "kv-plugin",
      ["tools:register", "storage:kv"],
      { "tools/kv-probe.js": KV_TOOL },
    );
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register", "storage:kv"],
      handlers: makeKvHandler(store),
    });
    await host.start();
    return await host.invokeTool("kv-probe", { seed });
  }

  test("kv.list returns the handler's page object, not an array of strings", async () => {
    const store = new Map<string, unknown>();
    const outcome = (await runProbe(store, ["a", "b"])) as {
      ok: boolean;
      output: {
        firstPageIsObject: boolean;
        allKeys: string[];
        firstValue: unknown;
      };
    };

    expect(outcome.ok).toBe(true);
    expect(outcome.output.firstPageIsObject).toBe(true);
    expect(outcome.output.allKeys).toEqual(["a", "b"]);
    // The value round-trips too — the old wrapper dropped values entirely,
    // mapping each row to `String(row)`.
    expect(outcome.output.firstValue).toEqual({ at: "a" });
  });

  test("paginates with afterKey until the last page omits nextAfterKey", async () => {
    const store = new Map<string, unknown>();
    // Seven keys over a page limit of three: two full pages, then a short
    // one that ends the walk.
    const seed = ["k1", "k2", "k3", "k4", "k5", "k6", "k7"];
    const outcome = (await runProbe(store, seed)) as {
      ok: boolean;
      output: {
        pages: Array<{ items: unknown[]; nextAfterKey?: string }>;
        allKeys: string[];
      };
    };

    expect(outcome.ok).toBe(true);
    expect(outcome.output.allKeys).toEqual(seed);
    expect(outcome.output.pages).toHaveLength(3);
    expect(outcome.output.pages[0]?.nextAfterKey).toBe("k3");
    expect(outcome.output.pages[1]?.nextAfterKey).toBe("k6");
    expect(outcome.output.pages[2]?.nextAfterKey).toBeUndefined();
    expect(outcome.output.pages[2]?.items).toHaveLength(1);
  });

  test("an empty store lists one empty page and stops", async () => {
    const store = new Map<string, unknown>();
    const outcome = (await runProbe(store, [])) as {
      ok: boolean;
      output: {
        pages: Array<{ items: unknown[]; nextAfterKey?: string }>;
        allKeys: string[];
      };
    };

    expect(outcome.ok).toBe(true);
    expect(outcome.output.allKeys).toEqual([]);
    expect(outcome.output.pages).toHaveLength(1);
    expect(outcome.output.pages[0]?.items).toEqual([]);
    expect(outcome.output.pages[0]?.nextAfterKey).toBeUndefined();
  });

  test("get, set and delete round-trip through the same path", async () => {
    const store = new Map<string, unknown>();
    const descriptor = await writePlugin(
      "kv-plugin",
      ["tools:register", "storage:kv"],
      {
        "tools/kv-crud.js": `
          export default {
            name: "kv-crud",
            description: "get/set/delete round trip.",
            inputSchema: { type: "object", properties: {} },
            async execute(_input, api) {
              await api.kv.set("x", { n: 1 });
              const afterSet = await api.kv.get("x");
              await api.kv.delete("x");
              const afterDelete = await api.kv.get("x");
              return { afterSet, afterDelete };
            },
          };
        `,
      },
    );
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register", "storage:kv"],
      handlers: makeKvHandler(store),
    });
    await host.start();

    const outcome = (await host.invokeTool("kv-crud", {})) as {
      ok: boolean;
      output: { afterSet: unknown; afterDelete: unknown };
    };

    expect(outcome.ok).toBe(true);
    expect(outcome.output.afterSet).toEqual({ n: 1 });
    expect(outcome.output.afterDelete).toBeNull();
  });

  test("kv.setSecret reaches the handler as its own op and reads back through get", async () => {
    const store = new Map<string, unknown>();
    const descriptor = await writePlugin(
      "kv-plugin",
      ["tools:register", "storage:kv"],
      {
        "tools/kv-secret.js": `
          export default {
            name: "kv-secret",
            description: "setSecret round trip.",
            inputSchema: { type: "object", properties: {} },
            async execute(_input, api) {
              await api.kv.set("plain", "visible");
              await api.kv.setSecret("token", "xoxb-super-secret");
              const readBack = await api.kv.get("token");
              const page = await api.kv.list();
              return { readBack, page };
            },
          };
        `,
      },
    );
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register", "storage:kv"],
      handlers: makeKvHandler(store),
    });
    await host.start();

    const outcome = (await host.invokeTool("kv-secret", {})) as {
      ok: boolean;
      output: {
        readBack: unknown;
        page: {
          items: Array<{ key: string; value: unknown; secret?: boolean }>;
        };
      };
    };

    expect(outcome.ok).toBe(true);
    // Sealed at rest: the raw stored value is not the plaintext.
    expect(JSON.stringify(store.get("token"))).not.toContain(
      "xoxb-super-secret",
    );
    // ...but the ordinary `get` gives it straight back.
    expect(outcome.output.readBack).toBe("xoxb-super-secret");

    const items = outcome.output.page.items;
    expect(items.find((item) => item.key === "token")?.secret).toBe(true);
    expect(items.find((item) => item.key === "token")?.value).toBeNull();
    expect(items.find((item) => item.key === "plain")?.value).toBe("visible");
  });

  test("kv is denied by the host's grant check and never reaches the handler", async () => {
    const descriptor = await writePlugin(
      "kv-plugin",
      ["tools:register", "storage:kv"],
      { "tools/kv-probe.js": KV_TOOL },
    );
    let handlerCalls = 0;
    const host = makeHost({
      descriptor,
      grantedCapabilities: ["tools:register"],
      handlers: {
        "storage:kv": () => {
          handlerCalls++;
          return Promise.resolve({ items: [] });
        },
      },
    });
    await host.start();

    const outcome = (await host.invokeTool("kv-probe", { seed: [] })) as {
      ok: boolean;
    };

    expect(handlerCalls).toBe(0);
    expect(outcome.ok).toBe(false);
  });
});
