import { describe, expect, mock, test } from "bun:test";

// `backend-factory.ts` and `instance-settings.ts` are both server-only; the
// marker package throws outside a server component and has nothing to do
// with what is being tested.
mock.module("server-only", () => ({}));

/**
 * Stands in for the id of the backend Poolside replaced.
 *
 * Written as a constant rather than that id's literal text because nothing
 * in `normalizeBackendId` special-cases it — the behaviour under test is the
 * general "a row holding an id this build does not know" rule, and naming
 * the retired backend here would only reintroduce a reference to it.
 */
const RETIRED_BACKEND_ID = "a-retired-backend";

let poolsideSettings = {
  baseUrl: null as string | null,
  apiKey: null as string | null,
  binaryPath: null as string | null,
};

/**
 * The settings row `resolveBackend` reads. Recorded rather than only
 * returned, so a test can prove the row actually reached the config the
 * backend was constructed with.
 */
const configCalls: Array<{
  baseUrl: string | null;
  apiKey: string | null;
  binaryPath: string | null;
}> = [];

mock.module("@/lib/settings/instance-settings", () => ({
  readInstanceSettings: async () => ({
    appDomain: null,
    tlsEnabled: false,
    previewBaseDomain: null,
    smtp: {
      host: null,
      port: null,
      secure: null,
      user: null,
      password: null,
      from: null,
    },
    poolside: poolsideSettings,
    onboardingCompletedAt: null,
  }),
}));

/**
 * `@paco/poolside-backend` spawns a `pool acp` process on `startTurn`.
 * Nothing here starts a turn, but the module is stubbed anyway so the test
 * exercises the FACTORY — which id it resolves, and which settings it hands
 * the constructor — without depending on the real package's internals.
 *
 * `buildPoolsideBackendConfig` is the package's own mapping (one place
 * decides which env var carries which field); the stub records its argument
 * so `resolveBackend` can be proven to pass the stored row through rather
 * than a hand-built approximation of it.
 */
mock.module("@paco/poolside-backend", () => ({
  buildPoolsideBackendConfig: (settings: {
    baseUrl: string | null;
    apiKey: string | null;
    binaryPath: string | null;
  }) => {
    configCalls.push(settings);
    return (settings.binaryPath ? { executable: settings.binaryPath } : {});
  },
  PoolsideBackend: class {
    config: unknown;
    constructor(config?: unknown) {
      this.config = config;
    }
    capabilities() {
      return {
        id: "poolside" as const,
        resume: true,
        steering: "restart" as const,
        mcp: true,
        effort: false,
        subagents: true,
        customAgents: false,
        structuredOutput: false,
        models: ["poolside/laguna-s-2.1", "poolside/laguna-xs-2.1"],
      };
    }
  },
}));

const modulePromise = import("./backend-factory");

describe("resolveBackend", () => {
  test("defaults to claude-code when chat.backend is absent", async () => {
    const { resolveBackend } = await modulePromise;

    const backend = await resolveBackend({});

    expect(backend.capabilities().id).toBe("claude-code");
  });

  test("resolves the claude-code backend explicitly", async () => {
    const { resolveBackend } = await modulePromise;

    const backend = await resolveBackend({ backend: "claude-code" });

    expect(backend.capabilities().id).toBe("claude-code");
  });

  test("falls back to claude-code, with a warning, for an unknown value", async () => {
    const { resolveBackend } = await modulePromise;
    const warnSpy = mock((..._args: unknown[]) => undefined);
    const originalWarn = console.warn;
    console.warn = warnSpy;

    try {
      const backend = await resolveBackend({ backend: "some-future-backend" });

      expect(backend.capabilities().id).toBe("claude-code");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain(
        "some-future-backend",
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  /**
   * The retired backend's id was a real value of `chats.backend` before
   * Poolside replaced it. Migration `0015_poolside_backend.sql` rewrites
   * those rows, but a row it somehow missed must still resolve to something
   * runnable rather than to a backend this build no longer contains.
   */
  test("a chat still holding the retired backend id runs on claude-code", async () => {
    const { resolveBackend } = await modulePromise;
    const originalWarn = console.warn;
    console.warn = () => {
      // Silenced: this case warns on purpose.
    };

    try {
      const backend = await resolveBackend({ backend: RETIRED_BACKEND_ID });

      expect(backend.capabilities().id).toBe("claude-code");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("resolves the poolside backend, reading its settings from instanceSettings", async () => {
    poolsideSettings = {
      baseUrl: "https://poolside.example.com",
      apiKey: "sk-poolside-secret",
      binaryPath: "/usr/local/bin/pool",
    };
    configCalls.length = 0;
    const { resolveBackend } = await modulePromise;

    const backend = await resolveBackend({ backend: "poolside" });

    expect(backend.capabilities().id).toBe("poolside");
    // The stored row reached the package's config mapping intact — including
    // the base URL, which the backend this replaced accepted and then
    // forwarded nowhere.
    expect(configCalls).toEqual([
      {
        baseUrl: "https://poolside.example.com",
        apiKey: "sk-poolside-secret",
        binaryPath: "/usr/local/bin/pool",
      },
    ]);
  });

  test("resolves poolside even with nothing configured, so `pool` on PATH still works", async () => {
    poolsideSettings = { baseUrl: null, apiKey: null, binaryPath: null };
    configCalls.length = 0;
    const { resolveBackend } = await modulePromise;

    const backend = await resolveBackend({ backend: "poolside" });

    expect(backend.capabilities().id).toBe("poolside");
    expect(configCalls).toHaveLength(1);
  });
});

describe("normalizeBackendId", () => {
  test("passes a known backend id through unchanged", async () => {
    const { normalizeBackendId } = await modulePromise;

    expect(normalizeBackendId("claude-code")).toBe("claude-code");
    expect(normalizeBackendId("poolside")).toBe("poolside");
  });

  test("falls back to claude-code for null and undefined", async () => {
    const { normalizeBackendId } = await modulePromise;

    expect(normalizeBackendId(null)).toBe("claude-code");
    expect(normalizeBackendId(undefined)).toBe("claude-code");
  });

  test("falls back to claude-code for an unrecognised non-null string", async () => {
    // The whole point of sharing this rule: the workflow's own fallback used
    // to catch only null/undefined, so an unrecognised string would have run
    // its turn on Claude Code while filing the resume token under that
    // string's key -- a token no later turn could ever find.
    const { normalizeBackendId } = await modulePromise;
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args[0]);
    };

    try {
      expect(normalizeBackendId("some-future-backend")).toBe("claude-code");
    } finally {
      console.warn = originalWarn;
    }

    expect(String(warnings[0])).toContain("some-future-backend");
  });

  test("agrees with resolveBackend for every input, so the two can never diverge", async () => {
    const { normalizeBackendId, resolveBackend } = await modulePromise;
    const inputs = [
      "claude-code",
      "poolside",
      RETIRED_BACKEND_ID,
      "some-future-backend",
      "",
      null,
      undefined,
    ] as const;
    const originalWarn = console.warn;
    console.warn = () => {
      // Silenced: the unknown-id cases warn on purpose.
    };

    try {
      for (const input of inputs) {
        const resolved = await resolveBackend({ backend: input });
        expect(resolved.capabilities().id).toBe(normalizeBackendId(input));
      }
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("CHAT_BACKEND_IDS / isKnownBackendId", () => {
  /**
   * The PATCH route validates a backend switch against `isKnownBackendId`
   * rather than a set of its own. This is the test that keeps that honest:
   * one list, and the two functions built on it answer the same way.
   */
  test("every id in the list is known, and nothing else is", async () => {
    const { CHAT_BACKEND_IDS, isKnownBackendId, normalizeBackendId } =
      await modulePromise;

    expect(CHAT_BACKEND_IDS).toEqual(["claude-code", "poolside"]);
    for (const id of CHAT_BACKEND_IDS) {
      expect(isKnownBackendId(id)).toBe(true);
      expect(normalizeBackendId(id)).toBe(id);
    }
    expect(isKnownBackendId(RETIRED_BACKEND_ID)).toBe(false);
    expect(isKnownBackendId("")).toBe(false);
  });
});
