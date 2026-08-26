import { describe, expect, test } from "bun:test";
import {
  buildPoolsideBackendConfig,
  POOLSIDE_DEFAULT_MODEL,
  POOLSIDE_MODEL_IDS,
  poolsideThoughtLevel,
} from "./config.ts";

describe("buildPoolsideBackendConfig", () => {
  test("maps every stored field onto something the process actually reads", () => {
    expect(
      buildPoolsideBackendConfig({
        baseUrl: "https://pool.example.com",
        apiKey: "sk-pool-secret",
        binaryPath: "/opt/poolside/bin/pool",
      }),
    ).toEqual({
      executable: "/opt/poolside/bin/pool",
      env: {
        // NOT POOLSIDE_API_URL: that one puts the CLI in "tenant" service
        // mode, a different thing from pointing it at your own endpoint.
        POOLSIDE_STANDALONE_BASE_URL: "https://pool.example.com",
        POOLSIDE_API_KEY: "sk-pool-secret",
      },
    });
  });

  test("empty settings produce an empty config, not empty strings", () => {
    // `pool` on PATH, and the signed-in credentials file — the default
    // install. An `env: {}` or `executable: ""` here would override that.
    expect(
      buildPoolsideBackendConfig({
        baseUrl: null,
        apiKey: null,
        binaryPath: null,
      }),
    ).toEqual({});
    expect(buildPoolsideBackendConfig({})).toEqual({});
  });

  /**
   * The login-only host, which is a first-class configuration and not a
   * half-finished one: `sudo paco auth poolside` runs `pool login` as the
   * service user, `AcpClient` forwards HOME/XDG_CONFIG_HOME, and the process
   * reads its own credentials file. Nothing is typed into Settings at all.
   *
   * Asserted key-by-key rather than with `toEqual({})` alone, because the
   * regression this guards against is not "an extra field appeared" but
   * "POOLSIDE_API_KEY appeared, empty" — which would reach the process, shadow
   * the credential it was signed in with, and fail every turn on a host whose
   * only visible symptom is that Settings looks blank.
   */
  test("a host signed in with `pool login` needs nothing in Settings", () => {
    const config = buildPoolsideBackendConfig({
      baseUrl: null,
      apiKey: null,
      binaryPath: null,
    });

    expect(config.env).toBeUndefined();
    expect(Object.keys(config)).toEqual([]);
    expect(JSON.stringify(config)).not.toContain("POOLSIDE_API_KEY");
  });

  test("an empty-string key is treated as absent, not sent as empty", () => {
    // What a form that submitted "" instead of null would produce. `pool`
    // would take the variable at face value and stop consulting its
    // credentials file, so the falsy check in the mapping is load-bearing.
    expect(buildPoolsideBackendConfig({ apiKey: "" }).env).toBeUndefined();
  });

  /**
   * A binary path is a *location*, not a credential. Setting one on a
   * login-only host — the normal case, since `pool` is not bundled and rarely
   * lands on systemd's PATH — must not start inventing an environment.
   */
  test("a binary path alone still leaves the process to its own credentials", () => {
    const config = buildPoolsideBackendConfig({
      binaryPath: "/opt/poolside/bin/pool",
      apiKey: null,
      baseUrl: null,
    });

    expect(config).toEqual({ executable: "/opt/poolside/bin/pool" });
    expect(config.env).toBeUndefined();
  });

  test("each field is independent of the others", () => {
    expect(
      buildPoolsideBackendConfig({ apiKey: "sk-only", baseUrl: null }),
    ).toEqual({ env: { POOLSIDE_API_KEY: "sk-only" } });
    expect(buildPoolsideBackendConfig({ binaryPath: "/usr/bin/pool" })).toEqual(
      {
        executable: "/usr/bin/pool",
      },
    );
  });
});

describe("model catalog", () => {
  test("declares the ids the live CLI offers, default first", () => {
    expect(POOLSIDE_MODEL_IDS).toEqual([
      "poolside/laguna-s-2.1",
      "poolside/laguna-xs-2.1",
    ]);
    expect(POOLSIDE_MODEL_IDS).toContain(POOLSIDE_DEFAULT_MODEL);
    expect(POOLSIDE_DEFAULT_MODEL).toBe("poolside/laguna-s-2.1");
  });

  test("carries no Claude tier aliases", () => {
    // Handing `opus`/`sonnet`/`haiku` to Poolside is the mistake OpenFX's
    // empty model list existed to prevent.
    for (const alias of ["opus", "sonnet", "haiku"]) {
      expect(POOLSIDE_MODEL_IDS).not.toContain(alias);
    }
  });
});

describe("poolsideThoughtLevel", () => {
  test("collapses Paco's five effort levels onto Poolside's two", () => {
    expect(poolsideThoughtLevel("low")).toBe("none");
    expect(poolsideThoughtLevel("medium")).toBe("none");
    expect(poolsideThoughtLevel("high")).toBe("max");
    expect(poolsideThoughtLevel("xhigh")).toBe("max");
    expect(poolsideThoughtLevel("max")).toBe("max");
  });

  test("leaves the session default alone for anything it does not recognise", () => {
    // Returning a level here would silently override Poolside's own
    // default; `undefined` means "don't send a config option at all".
    expect(poolsideThoughtLevel(undefined)).toBeUndefined();
    expect(poolsideThoughtLevel("")).toBeUndefined();
    expect(poolsideThoughtLevel("ludicrous")).toBeUndefined();
  });
});
