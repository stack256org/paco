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
    expect(settings.smtp.host).toBeNull();
    expect(settings.smtp.password).toBeNull();
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

  test("the SMTP password is sealed at rest and readable back", async () => {
    stored = null;
    const { readInstanceSettings, saveSmtpSettings } = await modulePromise;

    await saveSmtpSettings({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "paco",
      password: "hunter2",
      from: "Paco <no-reply@example.com>",
    });

    // Cast needed: TypeScript narrows `stored` to exactly `null` from the
    // assignment above and won't widen it back to `Row | null` across the
    // `await`, even though the fake db's `onConflictDoUpdate` reassigns it.
    const storedRow = stored as Row | null;
    expect(storedRow?.smtpPasswordSealed).toBeTruthy();
    expect(String(storedRow?.smtpPasswordSealed)).not.toContain("hunter2");

    const settings = await readInstanceSettings();
    expect(settings.smtp.password).toBe("hunter2");
  });

  test("a null password leaves the stored one alone", async () => {
    stored = null;
    const { readInstanceSettings, saveSmtpSettings } = await modulePromise;

    const base = {
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "paco",
      from: "Paco <no-reply@example.com>",
    };

    await saveSmtpSettings({ ...base, password: "hunter2" });
    await saveSmtpSettings({ ...base, user: "changed", password: null });

    const settings = await readInstanceSettings();
    expect(settings.smtp.user).toBe("changed");
    expect(settings.smtp.password).toBe("hunter2");
  });

  test("the OpenFX API key is sealed at rest and readable back", async () => {
    stored = null;
    const { readInstanceSettings, saveOpenFxSettings } = await modulePromise;

    await saveOpenFxSettings({
      endpoint: "https://gateway.example.com",
      apiKey: "sk-openfx-secret",
      binaryPath: "/usr/local/bin/openfx",
    });

    // Same narrowing issue as the SMTP test above: `stored` is reassigned
    // inside the fake db's `onConflictDoUpdate`, across an `await`.
    const storedRow = stored as Row | null;
    expect(storedRow?.openfxApiKeySealed).toBeTruthy();
    expect(String(storedRow?.openfxApiKeySealed)).not.toContain(
      "sk-openfx-secret",
    );

    const settings = await readInstanceSettings();
    expect(settings.openfx.endpoint).toBe("https://gateway.example.com");
    expect(settings.openfx.apiKey).toBe("sk-openfx-secret");
    expect(settings.openfx.binaryPath).toBe("/usr/local/bin/openfx");
  });

  test("a null OpenFX API key leaves the stored one alone", async () => {
    stored = null;
    const { readInstanceSettings, saveOpenFxSettings } = await modulePromise;

    await saveOpenFxSettings({
      endpoint: "https://gateway.example.com",
      apiKey: "sk-openfx-secret",
      binaryPath: "/usr/local/bin/openfx",
    });
    await saveOpenFxSettings({
      endpoint: "https://new-gateway.example.com",
      apiKey: null,
      binaryPath: "/usr/local/bin/openfx",
    });

    const settings = await readInstanceSettings();
    expect(settings.openfx.endpoint).toBe("https://new-gateway.example.com");
    expect(settings.openfx.apiKey).toBe("sk-openfx-secret");
  });

  test("a fresh install reads OpenFX settings as unconfigured", async () => {
    stored = null;
    const { readInstanceSettings } = await modulePromise;

    const settings = await readInstanceSettings();
    expect(settings.openfx.endpoint).toBeNull();
    expect(settings.openfx.apiKey).toBeNull();
    expect(settings.openfx.binaryPath).toBeNull();
  });
});
