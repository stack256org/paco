import { describe, expect, mock, spyOn, test } from "bun:test";
import { plugins } from "@/lib/db/schema";
import type { Capability, PluginManifest } from "@paco/plugin-kit";

// The module under test is server-only; the marker package throws outside a
// server component and has nothing to do with what is being tested.
mock.module("server-only", () => ({}));

// `ensurePluginIngressSecret` seals through `lib/crypto/secret-box`, which
// derives its key from APP_SECRET — same fixture value `secret-box.test.ts`
// uses.
process.env.APP_SECRET ??= "test-secret-for-secret-box-000000000000";

type Row = {
  id: string;
  source: string;
  version: string;
  contentHash: string;
  manifest: unknown;
  grantedCapabilities: unknown;
  consentedNetDomains: unknown;
  enabled: boolean;
  ingressSecret: string | null;
  installedBy: string | null;
  installedAt: Date;
  updatedAt: Date;
};
type Predicate = (row: Row) => boolean;

/**
 * Same trick as `session-events.test.ts` and `roster.test.ts`: a tiny
 * in-memory store plus real column objects from the schema, so a mocked
 * `eq` can filter it the way Drizzle would filter real rows, without
 * standing up a real Postgres.
 */
const COLUMN_KEYS = new Map<unknown, keyof Row>([[plugins.id, "id"]]);

function keyFor(column: unknown): keyof Row {
  const key = COLUMN_KEYS.get(column);
  if (!key) {
    throw new Error("Fake db: unmapped column referenced in a test");
  }
  return key;
}

const actualDrizzle = await import("drizzle-orm");

mock.module("drizzle-orm", () => ({
  ...actualDrizzle,
  eq:
    (column: unknown, value: unknown): Predicate =>
    (row) =>
      row[keyFor(column)] === value,
  asc: (_column: unknown) => undefined,
}));

let store: Row[] = [];

function makeRow(partial: Partial<Row>): Row {
  const now = new Date();
  return {
    id: partial.id ?? "row-id",
    source: partial.source ?? "local:/tmp/plugin",
    version: partial.version ?? "1.0.0",
    contentHash: partial.contentHash ?? "hash",
    manifest: partial.manifest,
    grantedCapabilities: partial.grantedCapabilities ?? [],
    consentedNetDomains: partial.consentedNetDomains ?? [],
    enabled: partial.enabled ?? false,
    ingressSecret: partial.ingressSecret ?? null,
    installedBy: partial.installedBy ?? null,
    installedAt: partial.installedAt ?? now,
    updatedAt: partial.updatedAt ?? now,
  };
}

const fakeDb = {
  select: (_columns?: Record<string, unknown>) => ({
    from: (_table: unknown) => ({
      where: (predicate: Predicate) => {
        const matched = store.filter(predicate);
        return Promise.resolve(matched.map((row) => ({ ...row })));
      },
      orderBy: (_order: unknown) =>
        Promise.resolve(
          [...store]
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            .map((row) => ({ ...row })),
        ),
    }),
  }),
  insert: (_table: unknown) => ({
    values: (values: Partial<Row> | Array<Partial<Row>>) => {
      const rows = Array.isArray(values) ? values : [values];
      for (const value of rows) {
        store.push(makeRow(value));
      }
      return Promise.resolve();
    },
  }),
  update: (_table: unknown) => ({
    set: (patch: Partial<Row>) => ({
      where: (predicate: Predicate) => {
        for (const row of store) {
          if (predicate(row)) {
            Object.assign(row, patch);
          }
        }
        return Promise.resolve();
      },
    }),
  }),
  delete: (_table: unknown) => ({
    where: (predicate: Predicate) => {
      store = store.filter((row) => !predicate(row));
      return Promise.resolve();
    },
  }),
};

mock.module("@/lib/db/client", () => ({ db: fakeDb }));

const {
  ensurePluginIngressSecret,
  PluginGrantEscalationError,
  getPlugin,
  listPlugins,
  removePlugin,
  setPluginEnabled,
  setPluginGrants,
  upsertPlugin,
} = await import("./plugins");
// Also server-only; imported dynamically, after the mock above, for the
// same reason `./plugins` is.
const { open } = await import("@/lib/crypto/secret-box");

function manifestWithCapabilities(
  capabilities: Capability[],
  id = "my-plugin",
): PluginManifest {
  return {
    name: id,
    version: "1.0.0",
    description: "Does a thing.",
    pacoApi: 1,
    capabilities,
    ...(capabilities.includes("net:fetch")
      ? { netDomains: ["api.example.com"] }
      : {}),
  };
}

describe("upsertPlugin / getPlugin", () => {
  test("round-trips a plugin row", async () => {
    store = [];
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "1.0.0",
      contentHash: "sha256:abc",
      manifest: manifestWithCapabilities(["events:subscribe"]),
      grantedCapabilities: [],
    });

    const row = await getPlugin("my-plugin");
    expect(row).toBeDefined();
    expect(row?.id).toBe("my-plugin");
    expect(row?.source).toBe("local:/tmp/my-plugin");
    expect(row?.version).toBe("1.0.0");
    expect(row?.contentHash).toBe("sha256:abc");
    expect(row?.manifest).toEqual(
      manifestWithCapabilities(["events:subscribe"]),
    );
  });

  test("records installedBy as the plugin's security principal", async () => {
    store = [];
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "1.0.0",
      contentHash: "sha256:abc",
      manifest: manifestWithCapabilities([]),
      grantedCapabilities: [],
      installedBy: "admin-1",
    });

    const row = await getPlugin("my-plugin");
    expect(row?.installedBy).toBe("admin-1");
  });

  test("a re-install by a different administrator re-attributes the principal", async () => {
    store = [];
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "1.0.0",
      contentHash: "sha256:abc",
      manifest: manifestWithCapabilities([]),
      grantedCapabilities: [],
      installedBy: "admin-1",
    });
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "2.0.0",
      contentHash: "sha256:def",
      manifest: manifestWithCapabilities([]),
      grantedCapabilities: [],
      installedBy: "admin-2",
    });

    // Consent is to the code that was just reviewed, so the person who
    // reviewed it is who the plugin now acts as.
    const row = await getPlugin("my-plugin");
    expect(row?.installedBy).toBe("admin-2");
  });

  test("an upsert that names no installer carries the existing one forward instead of erasing it", async () => {
    store = [];
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "1.0.0",
      contentHash: "sha256:abc",
      manifest: manifestWithCapabilities([]),
      grantedCapabilities: [],
      installedBy: "admin-1",
    });
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "2.0.0",
      contentHash: "sha256:def",
      manifest: manifestWithCapabilities([]),
      grantedCapabilities: [],
    });

    const row = await getPlugin("my-plugin");
    expect(row?.installedBy).toBe("admin-1");
  });

  test("a row that never had an installer stays without one rather than inventing a principal", async () => {
    store = [];
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "1.0.0",
      contentHash: "sha256:abc",
      manifest: manifestWithCapabilities([]),
      grantedCapabilities: [],
    });

    const row = await getPlugin("my-plugin");
    expect(row?.installedBy).toBeNull();
  });

  test("an explicit null installer clears the principal, so a deleted installer cannot be resurrected", async () => {
    store = [];
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "1.0.0",
      contentHash: "sha256:abc",
      manifest: manifestWithCapabilities([]),
      grantedCapabilities: [],
      installedBy: "admin-1",
    });
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "2.0.0",
      contentHash: "sha256:def",
      manifest: manifestWithCapabilities([]),
      grantedCapabilities: [],
      installedBy: null,
    });

    const row = await getPlugin("my-plugin");
    expect(row?.installedBy).toBeNull();
  });

  test("a stored installedBy that is not a usable id reads back as no principal, never as an empty one", async () => {
    // A hand-edited or otherwise corrupt row: `""` would be a string that
    // passes a naive truthiness check while naming nobody. Fail closed.
    store = [
      makeRow({
        id: "my-plugin",
        manifest: manifestWithCapabilities([]),
        grantedCapabilities: [],
        installedBy: "",
      }),
    ];

    const row = await getPlugin("my-plugin");
    expect(row).toBeDefined();
    expect(row?.installedBy).toBeNull();
  });

  test("enabled defaults to false: install is consent-gated", async () => {
    store = [];
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "1.0.0",
      contentHash: "sha256:abc",
      manifest: manifestWithCapabilities([]),
      grantedCapabilities: [],
    });

    const row = await getPlugin("my-plugin");
    expect(row?.enabled).toBe(false);
  });

  test("upserting the same id again updates in place, not duplicates", async () => {
    store = [];
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "1.0.0",
      contentHash: "sha256:abc",
      manifest: manifestWithCapabilities([]),
      grantedCapabilities: [],
    });
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "2.0.0",
      contentHash: "sha256:def",
      manifest: manifestWithCapabilities([]),
      grantedCapabilities: [],
    });

    const all = await listPlugins();
    expect(all).toHaveLength(1);
    expect(all[0]?.version).toBe("2.0.0");
  });

  test("getPlugin returns undefined for an unknown id", async () => {
    store = [];
    const row = await getPlugin("nope");
    expect(row).toBeUndefined();
  });

  test("throws when the supplied manifest is invalid", async () => {
    store = [];
    await expect(
      upsertPlugin({
        id: "my-plugin",
        source: "local:/tmp/my-plugin",
        version: "1.0.0",
        contentHash: "hash",
        manifest: { garbage: true } as unknown as PluginManifest,
        grantedCapabilities: [],
      }),
    ).rejects.toThrow();
    expect(store).toHaveLength(0);
  });

  test("trims a supplied grant that is outside the manifest's capabilities, without throwing", async () => {
    store = [];
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "1.0.0",
      contentHash: "hash",
      manifest: manifestWithCapabilities(["events:subscribe"]),
      grantedCapabilities: ["events:subscribe", "net:fetch"],
    });

    const row = await getPlugin("my-plugin");
    expect(row?.grantedCapabilities).toEqual(["events:subscribe"]);
  });

  test("trims a previously granted capability the new manifest no longer declares", async () => {
    store = [];
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "1.0.0",
      contentHash: "hash",
      manifest: manifestWithCapabilities(["events:subscribe", "net:fetch"]),
      grantedCapabilities: [],
    });
    await setPluginGrants("my-plugin", ["events:subscribe", "net:fetch"]);

    // Re-install with a manifest that no longer declares "net:fetch",
    // carrying the previous grants forward the way a real installer would.
    const before = await getPlugin("my-plugin");
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "2.0.0",
      contentHash: "hash2",
      manifest: manifestWithCapabilities(["events:subscribe"]),
      grantedCapabilities: before?.grantedCapabilities ?? [],
    });

    const after = await getPlugin("my-plugin");
    expect(after?.grantedCapabilities).toEqual(["events:subscribe"]);
  });

  test("a plain re-install with grantedCapabilities: [] preserves an existing grant the manifest still declares", async () => {
    store = [];
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "1.0.0",
      contentHash: "hash",
      manifest: manifestWithCapabilities(["events:subscribe"]),
      grantedCapabilities: [],
    });
    await setPluginGrants("my-plugin", ["events:subscribe"]);

    // The installer always passes grantedCapabilities: [] on upsert; the
    // existing grant must not be wiped just because the manifest is
    // unchanged and re-declares the same capability.
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "1.0.1",
      contentHash: "hash3",
      manifest: manifestWithCapabilities(["events:subscribe"]),
      grantedCapabilities: [],
    });

    const row = await getPlugin("my-plugin");
    expect(row?.grantedCapabilities).toEqual(["events:subscribe"]);
  });
});

describe("listPlugins", () => {
  test("lists plugins ordered by id", async () => {
    store = [];
    await upsertPlugin({
      id: "zeta",
      source: "local:/tmp/zeta",
      version: "1.0.0",
      contentHash: "hash",
      manifest: manifestWithCapabilities([]),
      grantedCapabilities: [],
    });
    await upsertPlugin({
      id: "alpha",
      source: "local:/tmp/alpha",
      version: "1.0.0",
      contentHash: "hash",
      manifest: manifestWithCapabilities([]),
      grantedCapabilities: [],
    });

    const all = await listPlugins();
    expect(all.map((row) => row.id)).toEqual(["alpha", "zeta"]);
  });
});

describe("setPluginEnabled", () => {
  test("flips enabled without touching other fields", async () => {
    store = [];
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "1.0.0",
      contentHash: "hash",
      manifest: manifestWithCapabilities([]),
      grantedCapabilities: [],
    });

    await setPluginEnabled("my-plugin", true);

    const row = await getPlugin("my-plugin");
    expect(row?.enabled).toBe(true);
    expect(row?.version).toBe("1.0.0");
  });
});

describe("setPluginGrants", () => {
  test("accepts grants that are a subset of the manifest's capabilities", async () => {
    store = [];
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "1.0.0",
      contentHash: "hash",
      manifest: manifestWithCapabilities(["events:subscribe", "storage:kv"]),
      grantedCapabilities: [],
    });

    await setPluginGrants("my-plugin", ["events:subscribe"]);

    const row = await getPlugin("my-plugin");
    expect(row?.grantedCapabilities).toEqual(["events:subscribe"]);
  });

  test("throws PluginGrantEscalationError for a capability outside the manifest", async () => {
    store = [];
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "1.0.0",
      contentHash: "hash",
      manifest: manifestWithCapabilities(["events:subscribe"]),
      grantedCapabilities: [],
    });

    await expect(
      setPluginGrants("my-plugin", ["events:subscribe", "net:fetch"]),
    ).rejects.toThrow(PluginGrantEscalationError);

    const row = await getPlugin("my-plugin");
    expect(row?.grantedCapabilities).toEqual([]);
  });

  test("throws for an unknown plugin id", async () => {
    store = [];
    await expect(
      setPluginGrants("does-not-exist", ["events:subscribe"]),
    ).rejects.toThrow();
  });

  test("throws even for an empty grants request when the manifest is unparseable, and logs it", async () => {
    store = [
      makeRow({
        id: "my-plugin",
        manifest: { garbage: true } as unknown as PluginManifest,
        grantedCapabilities: [],
      }),
    ];
    const errorSpy = spyOn(console, "error").mockImplementation(() => {
      // silence expected log during the test
    });

    await expect(setPluginGrants("my-plugin", [])).rejects.toThrow(
      PluginGrantEscalationError,
    );
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

describe("removePlugin", () => {
  test("removes the row", async () => {
    store = [];
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "1.0.0",
      contentHash: "hash",
      manifest: manifestWithCapabilities([]),
      grantedCapabilities: [],
    });

    await removePlugin("my-plugin");

    expect(await getPlugin("my-plugin")).toBeUndefined();
    expect(await listPlugins()).toHaveLength(0);
  });
});

describe("consentedNetDomains", () => {
  test("setPluginGrants snapshots manifest.netDomains into consentedNetDomains", async () => {
    store = [];
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "1.0.0",
      contentHash: "hash",
      manifest: manifestWithCapabilities(["net:fetch"]),
      grantedCapabilities: [],
    });

    // Fresh install: no consent given yet.
    expect((await getPlugin("my-plugin"))?.consentedNetDomains).toEqual([]);

    await setPluginGrants("my-plugin", ["net:fetch"]);

    const row = await getPlugin("my-plugin");
    expect(row?.consentedNetDomains).toEqual(["api.example.com"]);
  });

  test("setPluginGrants snapshots netDomains even when net:fetch is not among the requested grants", async () => {
    store = [];
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "1.0.0",
      contentHash: "hash",
      manifest: manifestWithCapabilities(["net:fetch", "events:subscribe"]),
      grantedCapabilities: [],
    });

    await setPluginGrants("my-plugin", ["events:subscribe"]);

    const row = await getPlugin("my-plugin");
    expect(row?.consentedNetDomains).toEqual(["api.example.com"]);
  });

  test("upsertPlugin on re-install intersects existing consentedNetDomains with the new manifest's netDomains, never widening", async () => {
    store = [];
    const manifestV1 = {
      ...manifestWithCapabilities(["net:fetch"]),
      netDomains: ["api.example.com", "cdn.example.com"],
    };
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "1.0.0",
      contentHash: "hash",
      manifest: manifestV1,
      grantedCapabilities: [],
    });
    await setPluginGrants("my-plugin", ["net:fetch"]);

    const before = await getPlugin("my-plugin");
    expect(before?.consentedNetDomains).toEqual([
      "api.example.com",
      "cdn.example.com",
    ]);

    // Re-install with a manifest that widens netDomains further: the
    // widened domain must NOT appear in consentedNetDomains — only
    // `setPluginGrants` (an explicit operator act) can add to it.
    const manifestV2 = {
      ...manifestWithCapabilities(["net:fetch"]),
      netDomains: ["api.example.com", "cdn.example.com", "new-domain.com"],
    };
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "2.0.0",
      contentHash: "hash2",
      manifest: manifestV2,
      grantedCapabilities: [],
    });

    const afterWiden = await getPlugin("my-plugin");
    expect(afterWiden?.consentedNetDomains).toEqual([
      "api.example.com",
      "cdn.example.com",
    ]);

    // Re-install with a manifest that drops a previously consented domain:
    // the drop must be reflected (intersection, not carry-forward).
    const manifestV3 = {
      ...manifestWithCapabilities(["net:fetch"]),
      netDomains: ["api.example.com"],
    };
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "3.0.0",
      contentHash: "hash3",
      manifest: manifestV3,
      grantedCapabilities: [],
    });

    const afterShrink = await getPlugin("my-plugin");
    expect(afterShrink?.consentedNetDomains).toEqual(["api.example.com"]);
  });

  test("an invalid consentedNetDomains value excludes the row from getPlugin/listPlugins", async () => {
    store = [
      makeRow({
        id: "my-plugin",
        manifest: manifestWithCapabilities(["net:fetch"]),
        grantedCapabilities: [],
        consentedNetDomains: [42, "not-a-string"],
      }),
    ];
    const errorSpy = spyOn(console, "error").mockImplementation(() => {
      // silence expected log during the test
    });

    expect(await getPlugin("my-plugin")).toBeUndefined();
    expect(await listPlugins()).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

describe("ensurePluginIngressSecret", () => {
  test("generates and seals a secret, returning it in the clear once", async () => {
    store = [];
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "1.0.0",
      contentHash: "hash",
      manifest: manifestWithCapabilities(["channels:ingress"]),
      grantedCapabilities: [],
    });

    const secret = await ensurePluginIngressSecret("my-plugin");

    expect(secret).toBeDefined();
    if (!secret) {
      return;
    }
    const row = await getPlugin("my-plugin");
    expect(row?.ingressSecret).toBeTruthy();
    // Never stored in the clear.
    expect(row?.ingressSecret).not.toBe(secret);
    expect(open(row?.ingressSecret ?? "")).toBe(secret);
  });

  test("is a no-op on a plugin that already has a secret, and does not return one", async () => {
    store = [];
    await upsertPlugin({
      id: "my-plugin",
      source: "local:/tmp/my-plugin",
      version: "1.0.0",
      contentHash: "hash",
      manifest: manifestWithCapabilities(["channels:ingress"]),
      grantedCapabilities: [],
    });
    const first = await ensurePluginIngressSecret("my-plugin");
    expect(first).toBeDefined();
    if (!first) {
      return;
    }

    const second = await ensurePluginIngressSecret("my-plugin");

    expect(second).toBeUndefined();
    const row = await getPlugin("my-plugin");
    expect(open(row?.ingressSecret ?? "")).toBe(first);
  });

  test("throws for an unknown plugin id", async () => {
    store = [];
    await expect(ensurePluginIngressSecret("does-not-exist")).rejects.toThrow();
  });
});
