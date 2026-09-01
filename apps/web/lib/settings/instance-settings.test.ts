import { describe, expect, mock, test } from "bun:test";

// The module under test is server-only; the marker package throws outside a
// server component and has nothing to do with what is being tested.
mock.module("server-only", () => ({}));

process.env.APP_SECRET ??= "test-secret-for-sealing-values-0123456789";

type Row = Record<string, unknown>;

let stored: Row | null = null;

const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => (stored ? [stored] : []),
      }),
    }),
  }),
  insert: () => ({
    values: (values: Row) => ({
      onConflictDoUpdate: async ({ set }: { set: Row }) => {
        stored = { ...stored, ...values, ...set };
      },
    }),
  }),
};

mock.module("@/lib/db/client", () => ({ db: fakeDb }));

const modulePromise = import("./instance-settings");

describe("instance settings", () => {
  test("a fresh install reads as unconfigured", async () => {
    stored = null;
    const { readInstanceSettings } = await modulePromise;

    const settings = await readInstanceSettings();

    expect(settings.appDomain).toBeNull();
    expect(settings.tlsEnabled).toBe(false);
  });

  test("saving a domain round-trips", async () => {
    stored = null;
    const { readInstanceSettings, saveAppDomain } = await modulePromise;

    await saveAppDomain({
      appDomain: "https://paco.example.com",
      tlsEnabled: true,
      previewBaseDomain: "previews.example.com",
    });

    const settings = await readInstanceSettings();
    expect(settings.appDomain).toBe("https://paco.example.com");
    expect(settings.tlsEnabled).toBe(true);
    expect(settings.previewBaseDomain).toBe("previews.example.com");
  });
});
