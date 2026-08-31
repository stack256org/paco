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
    expect(settings.onboardingCompletedAt).toBeNull();
  });

  test("completing onboarding round-trips", async () => {
    stored = null;
    const { readInstanceSettings, markOnboardingComplete } =
      await modulePromise;

    expect((await readInstanceSettings()).onboardingCompletedAt).toBeNull();

    await markOnboardingComplete();

    const settings = await readInstanceSettings();
    expect(settings.onboardingCompletedAt).toBeInstanceOf(Date);
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

  test("the Poolside API key is sealed at rest and readable back", async () => {
    stored = null;
    const { readInstanceSettings, savePoolsideSettings } = await modulePromise;

    await savePoolsideSettings({
      baseUrl: "https://pool.example.com",
      apiKey: "sk-poolside-secret",
      binaryPath: "/usr/local/bin/pool",
    });

    // Same narrowing issue as the SMTP test above: `stored` is reassigned
    // inside the fake db's `onConflictDoUpdate`, across an `await`.
    const storedRow = stored as Row | null;
    expect(storedRow?.poolsideApiKeySealed).toBeTruthy();
    expect(String(storedRow?.poolsideApiKeySealed)).not.toContain(
      "sk-poolside-secret",
    );

    const settings = await readInstanceSettings();
    expect(settings.poolside.baseUrl).toBe("https://pool.example.com");
    expect(settings.poolside.apiKey).toBe("sk-poolside-secret");
    expect(settings.poolside.binaryPath).toBe("/usr/local/bin/pool");
  });

  test("a null Poolside API key leaves the stored one alone", async () => {
    stored = null;
    const { readInstanceSettings, savePoolsideSettings } = await modulePromise;

    await savePoolsideSettings({
      baseUrl: "https://pool.example.com",
      apiKey: "sk-poolside-secret",
      binaryPath: "/usr/local/bin/pool",
    });
    await savePoolsideSettings({
      baseUrl: "https://standalone.example.com",
      apiKey: null,
      binaryPath: "/usr/local/bin/pool",
    });

    const settings = await readInstanceSettings();
    expect(settings.poolside.baseUrl).toBe("https://standalone.example.com");
    expect(settings.poolside.apiKey).toBe("sk-poolside-secret");
  });

  test("a fresh install reads Poolside settings as unconfigured", async () => {
    stored = null;
    const { readInstanceSettings } = await modulePromise;

    const settings = await readInstanceSettings();
    expect(settings.poolside.baseUrl).toBeNull();
    expect(settings.poolside.apiKey).toBeNull();
    expect(settings.poolside.binaryPath).toBeNull();
  });

  /**
   * Migration 0015 drops the `openfx_*` columns rather than renaming them.
   * This is the read side of that decision: even if an OpenFX-era row were
   * somehow still around, none of its values may surface as Poolside
   * configuration. A carried-over key would authenticate against nothing and
   * fail on the first turn — worse than an empty field that asks for one.
   */
  test("an OpenFX-era row contributes nothing to Poolside settings", async () => {
    const { readInstanceSettings, savePoolsideSettings } = await modulePromise;
    const { seal } = await import("@/lib/crypto/secret-box");

    stored = {
      openfxEndpoint: "https://gateway.example.com",
      openfxApiKeySealed: seal("sk-openfx-secret"),
      openfxBinaryPath: "/usr/local/bin/openfx",
    };

    const settings = await readInstanceSettings();
    expect(settings.poolside.baseUrl).toBeNull();
    expect(settings.poolside.apiKey).toBeNull();
    expect(settings.poolside.binaryPath).toBeNull();

    // Nothing in the view even names the removed backend anymore.
    expect(Object.keys(settings)).not.toContain("openfx");

    // The operator re-enters it, and that is the only way it gets set.
    await savePoolsideSettings({
      baseUrl: null,
      apiKey: "sk-poolside-secret",
      binaryPath: null,
    });
    expect((await readInstanceSettings()).poolside.apiKey).toBe(
      "sk-poolside-secret",
    );
  });
});
