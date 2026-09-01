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
      // Some callers (and the brief's own assertion below) read the row
      // straight off `from()` without a `where()`, since there is only ever
      // one row to find.
      limit: async () => (stored ? [stored] : []),
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
const dbClientPromise = import("@/lib/db/client");
const schemaPromise = import("@/lib/db/schema");

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

describe("claude credential", () => {
  test("round-trips an api key through the seal", async () => {
    stored = null;
    const { saveClaudeCredential, readClaudeCredential } = await modulePromise;

    await saveClaudeCredential({ kind: "api_key", value: "sk-ant-test-123" });

    const credential = await readClaudeCredential();

    expect(credential?.kind).toBe("api_key");
    expect(credential?.value).toBe("sk-ant-test-123");
  });

  test("saving one kind clears the other", async () => {
    stored = null;
    const { saveClaudeCredential, readClaudeCredential } = await modulePromise;

    // The precedence trap this design exists to make unreachable: with both
    // set, ANTHROPIC_API_KEY wins in -p mode and silently bills the API
    // account instead of the subscription the operator pasted a token for.
    await saveClaudeCredential({ kind: "api_key", value: "sk-ant-test-123" });
    await saveClaudeCredential({ kind: "setup_token", value: "oauth-abc" });

    const credential = await readClaudeCredential();

    expect(credential?.kind).toBe("setup_token");
    expect(credential?.value).toBe("oauth-abc");
  });

  test("stores the credential sealed, never in the clear", async () => {
    stored = null;
    const { saveClaudeCredential } = await modulePromise;
    const { db } = await dbClientPromise;
    const { instanceSettings } = await schemaPromise;

    await saveClaudeCredential({ kind: "api_key", value: "sk-ant-secret" });

    const [row] = await db.select().from(instanceSettings).limit(1);

    expect(row?.claudeCredentialSealed).not.toContain("sk-ant-secret");
  });

  test("returns null when nothing is configured", async () => {
    stored = null;
    const { readClaudeCredential } = await modulePromise;

    expect(await readClaudeCredential()).toBeNull();
  });
});
