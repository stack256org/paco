import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// The module under test is server-only; the marker package throws outside a
// server component and has nothing to do with what is being tested.
mock.module("server-only", () => ({}));

let dbSettings = {
  host: null as string | null,
  port: null as number | null,
  secure: null as boolean | null,
  user: null as string | null,
  password: null as string | null,
  from: null as string | null,
};

mock.module("@/lib/settings/instance-settings", () => ({
  readInstanceSettings: async () => ({
    appDomain: null,
    tlsEnabled: false,
    previewBaseDomain: null,
    smtp: dbSettings,
  }),
}));

const modulePromise = import("./smtp-config");

const envKeys = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "SMTP_FROM",
];
const original: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of envKeys) {
    original[key] = process.env[key];
    delete process.env[key];
  }
  dbSettings = {
    host: null,
    port: null,
    secure: null,
    user: null,
    password: null,
    from: null,
  };
});

afterEach(() => {
  for (const key of envKeys) {
    if (original[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original[key];
    }
  }
});

describe("resolveSmtpConfig", () => {
  test("returns null when nothing is configured", async () => {
    const { resolveSmtpConfig } = await modulePromise;
    expect(await resolveSmtpConfig()).toBeNull();
  });

  test("uses the environment when the database is empty", async () => {
    process.env.SMTP_HOST = "smtp.env.example";
    process.env.SMTP_PORT = "2525";
    const { resolveSmtpConfig } = await modulePromise;

    const config = await resolveSmtpConfig();
    expect(config?.host).toBe("smtp.env.example");
    expect(config?.port).toBe(2525);
  });

  test("the database wins over the environment", async () => {
    process.env.SMTP_HOST = "smtp.env.example";
    dbSettings.host = "smtp.db.example";
    const { resolveSmtpConfig } = await modulePromise;

    expect((await resolveSmtpConfig())?.host).toBe("smtp.db.example");
  });

  test("implicit TLS is inferred from port 465", async () => {
    dbSettings.host = "smtp.db.example";
    dbSettings.port = 465;
    const { resolveSmtpConfig } = await modulePromise;

    expect((await resolveSmtpConfig())?.secure).toBe(true);
  });

  test("an explicit secure flag beats the port heuristic", async () => {
    dbSettings.host = "smtp.db.example";
    dbSettings.port = 465;
    dbSettings.secure = false;
    const { resolveSmtpConfig } = await modulePromise;

    expect((await resolveSmtpConfig())?.secure).toBe(false);
  });

  describe("source atomicity", () => {
    // A DB-configured host must take every field from the database, never
    // falling back per-field to the environment. Otherwise an operator who
    // moves to a new SMTP host in Settings but leaves, say, the username
    // blank would silently reattach whatever provider's credentials the
    // environment happens to hold — one provider's secret sent to a server
    // that isn't it.
    test("a DB-configured host does not inherit SMTP_USER from the environment", async () => {
      process.env.SMTP_USER = "env-user@example.com";
      dbSettings.host = "smtp.db.example";
      const { resolveSmtpConfig } = await modulePromise;

      expect((await resolveSmtpConfig())?.user).toBeNull();
    });

    test("a DB-configured host does not inherit SMTP_PASSWORD from the environment", async () => {
      process.env.SMTP_PASSWORD = "env-secret";
      dbSettings.host = "smtp.db.example";
      const { resolveSmtpConfig } = await modulePromise;

      expect((await resolveSmtpConfig())?.password).toBeNull();
    });

    test("a DB-configured host does not inherit SMTP_FROM from the environment", async () => {
      process.env.SMTP_FROM = "Env Sender <env@example.com>";
      dbSettings.host = "smtp.db.example";
      const { resolveSmtpConfig } = await modulePromise;

      expect((await resolveSmtpConfig())?.from).toBe(
        "Paco <no-reply@localhost>",
      );
    });

    test("a DB-configured host does not inherit SMTP_PORT from the environment", async () => {
      process.env.SMTP_PORT = "2525";
      dbSettings.host = "smtp.db.example";
      const { resolveSmtpConfig } = await modulePromise;

      expect((await resolveSmtpConfig())?.port).toBe(587);
    });

    test("a fully-empty DB uses the environment wholly, not just for host", async () => {
      process.env.SMTP_HOST = "smtp.env.example";
      process.env.SMTP_USER = "env-user@example.com";
      process.env.SMTP_PASSWORD = "env-secret";
      process.env.SMTP_FROM = "Env Sender <env@example.com>";
      process.env.SMTP_PORT = "2525";
      const { resolveSmtpConfig } = await modulePromise;

      const config = await resolveSmtpConfig();
      expect(config).toEqual({
        host: "smtp.env.example",
        port: 2525,
        secure: false,
        user: "env-user@example.com",
        password: "env-secret",
        from: "Env Sender <env@example.com>",
      });
    });
  });
});
