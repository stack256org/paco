import { describe, expect, mock, test } from "bun:test";
import type { BackendCapabilities } from "@paco/agent-backend";
import { PoolsideBackend } from "@paco/poolside-backend";
import { renderToStaticMarkup } from "react-dom/server";
import { poolsideSchema } from "@/lib/admin/instance-settings-schemas";

mock.module("@/lib/admin/instance-settings-actions", () => ({
  getInstanceSettings: () => Promise.resolve(null),
  testPoolsideConnection: () => Promise.resolve({ success: true }),
  updatePoolsideSettings: () => Promise.resolve({ success: true }),
}));
mock.module("@/lib/toast", () => ({
  toast: { error: () => {}, success: () => {} },
}));

const modulePromise = import("./poolside-provider-section");

/**
 * Poolside's capabilities, read from the backend itself.
 *
 * Not a hand-copied literal. The whole point of the section under test is
 * that its copy is derived from this object rather than written out, and a
 * transcribed fixture would reintroduce exactly the drift the derivation
 * removes: the package could change what Poolside supports, its own tests
 * would be updated to match, and the assertions below would keep passing
 * against a shape that no longer exists. Reading the real object means a
 * capability gained or lost turns into a failure here.
 *
 * Safe to construct in a test despite the package spawning processes — the
 * constructor is side-effect-free and takes no required config; only
 * `startTurn` spawns anything. `lib/agent/backend-capabilities.ts` relies on
 * the same property for the same reason, and the OpenFX section's test did
 * this before it.
 */
const POOLSIDE_CAPABILITIES: BackendCapabilities =
  new PoolsideBackend().capabilities();

const noop = () => {
  // no-op: only the rendered markup is asserted below
};

const STORED_KEY = "pool-sk-do-not-render-me";

async function renderForm(
  overrides: Partial<{
    baseUrl: string;
    binaryPath: string;
    apiKey: string;
    hasStoredApiKey: boolean;
    saving: boolean;
  }> = {},
) {
  const { PoolsideProviderForm } = await modulePromise;

  return renderToStaticMarkup(
    <PoolsideProviderForm
      form={{
        baseUrl: overrides.baseUrl ?? "https://poolside.example.com",
        binaryPath: overrides.binaryPath ?? "/usr/local/bin/pool",
        apiKey: overrides.apiKey ?? "",
      }}
      hasStoredApiKey={overrides.hasStoredApiKey ?? false}
      onChange={noop}
      onSubmit={noop}
      saving={overrides.saving ?? false}
    />,
  );
}

/**
 * The rendered `<input>` whose `id` is `id`, as a single tag.
 *
 * `renderToStaticMarkup` emits `disabled=""` for a disabled input and omits
 * the attribute entirely otherwise, so the tag itself is the whole evidence —
 * but only if the search is scoped to one tag. Asserting `not.toContain(
 * "disabled")` over the whole form would pass while the wrong field was
 * disabled.
 */
function inputTag(html: string, id: string): string {
  const start = html.indexOf(`<input`, 0);
  let cursor = start;
  while (cursor !== -1) {
    const end = html.indexOf(">", cursor);
    const tag = html.slice(cursor, end + 1);
    if (tag.includes(`id="${id}"`)) {
      return tag;
    }
    cursor = html.indexOf("<input", end);
  }
  throw new Error(`No <input> with id "${id}" in the rendered form`);
}

describe("PoolsideProviderForm", () => {
  /**
   * The behaviour change this whole rewrite exists for.
   *
   * OpenFX's endpoint input carried a bare `disabled` — not `disabled={form
   * === null || saving}`, an unconditional one — because that binary had no
   * flag or environment variable that moved where it sent provider traffic.
   * `pool` reads POOLSIDE_STANDALONE_BASE_URL and honours it, so the field
   * has to be live.
   */
  test("the base URL field is enabled once the settings have loaded", async () => {
    const html = await renderForm();

    expect(inputTag(html, "poolside-base-url")).not.toContain("disabled");
  });

  test("the base URL field is disabled only while loading or saving", async () => {
    const { PoolsideProviderForm } = await modulePromise;

    const loading = renderToStaticMarkup(
      <PoolsideProviderForm
        form={null}
        hasStoredApiKey={false}
        onChange={noop}
        onSubmit={noop}
        saving={false}
      />,
    );
    expect(inputTag(loading, "poolside-base-url")).toContain("disabled");

    const savingHtml = await renderForm({ saving: true });
    expect(inputTag(savingHtml, "poolside-base-url")).toContain("disabled");
  });

  test("the base URL field renders the stored value, so it can be edited", async () => {
    const html = await renderForm({ baseUrl: "https://pool.internal" });

    expect(inputTag(html, "poolside-base-url")).toContain(
      'value="https://pool.internal"',
    );
  });

  test("the caption no longer says the field does nothing", async () => {
    const html = await renderForm();

    expect(html).toContain("POOLSIDE_STANDALONE_BASE_URL");
    expect(html).not.toContain("would have no effect");
    expect(html).not.toContain("Disabled:");
  });

  /**
   * The secret half of the contract. `getInstanceSettings` sends down
   * `hasApiKey`, a boolean, and never the key — so even with one stored the
   * field renders empty and only its placeholder says a key exists.
   */
  test("a stored API key is never rendered back into the form", async () => {
    const html = await renderForm({ hasStoredApiKey: true });
    const field = inputTag(html, "poolside-api-key");

    expect(html).not.toContain(STORED_KEY);
    expect(field).toContain('value=""');
    expect(field).toContain('type="password"');
    expect(field).toContain("A key is already stored");
  });

  test("a typed API key is masked rather than shown", async () => {
    const html = await renderForm({ apiKey: STORED_KEY });

    expect(inputTag(html, "poolside-api-key")).toContain('type="password"');
  });

  /**
   * The honesty fix `paco auth poolside` exists for.
   *
   * `pool` authenticates two ways and the form only ever named one, so an
   * operator who had no key read this page as "you cannot use Poolside" —
   * when `sudo paco auth poolside` on the host would have signed the service
   * user in and needed nothing on this form at all. `buildPoolsideBackendConfig`
   * has always tolerated that (empty settings produce an empty config, so the
   * process falls through to its own credentials file); the copy is what did
   * not.
   *
   * Asserted on the rendered markup rather than on a string constant, because
   * the failure this guards against is the page going back to implying a key
   * is mandatory — which is a rendering, not a variable.
   */
  test("the form says a key is not required and names the other way in", async () => {
    const html = await renderForm();

    expect(html).toContain("A key is not required.");
    expect(html).toContain("sudo paco auth poolside");
    expect(html).toContain("pool login");
  });

  /**
   * The trap on the other side of the same fact. A key alone is NOT enough:
   * `pool` resolves an API URL separately, from `settings.yaml` or
   * POOLSIDE_STANDALONE_BASE_URL, and with neither it refuses every session
   * with "API URL not configured. Run pool login to authenticate" — a message
   * that reads like a broken key rather than a missing URL.
   */
  test("the key caption says a key alone is not enough", async () => {
    const html = await renderForm();

    expect(html).toContain("POOLSIDE_API_KEY");
    expect(html).toContain("On its own it is not enough");
    expect(html).toContain("https://inference.poolside.ai");
  });

  /**
   * The note has to survive the load, because that is exactly when an
   * operator with no credentials is reading it.
   */
  test("the terminal-login note renders while the settings are still loading", async () => {
    const { PoolsideProviderForm } = await modulePromise;

    const loading = renderToStaticMarkup(
      <PoolsideProviderForm
        form={null}
        hasStoredApiKey={false}
        onChange={noop}
        onSubmit={noop}
        saving={false}
      />,
    );

    expect(loading).toContain("sudo paco auth poolside");
  });
});

describe("toPoolsideUpdate", () => {
  test("submits the base URL, so an admin's edit actually reaches the server", async () => {
    const { toPoolsideUpdate } = await modulePromise;

    const update = toPoolsideUpdate({
      baseUrl: "  https://pool.internal  ",
      binaryPath: "/usr/local/bin/pool",
      apiKey: "",
    });

    expect(update.baseUrl).toBe("https://pool.internal");
    expect(poolsideSchema.safeParse(update).success).toBe(true);
  });

  /**
   * `poolsideSchema.binaryPath` is `z.string().trim().min(1).nullable()`, so
   * a cleared field submitted as `""` is a validation error rather than
   * "use whatever `pool` is on PATH".
   */
  test("a cleared field becomes null, which is what the schema accepts", async () => {
    const { toPoolsideUpdate } = await modulePromise;

    const update = toPoolsideUpdate({
      baseUrl: "   ",
      binaryPath: "",
      apiKey: "   ",
    });

    expect(update).toEqual({ baseUrl: null, binaryPath: null, apiKey: null });
    expect(poolsideSchema.safeParse(update).success).toBe(true);
  });

  test("a typed key is passed through unedited", async () => {
    const { toPoolsideUpdate } = await modulePromise;

    const update = toPoolsideUpdate({
      baseUrl: "",
      binaryPath: "",
      apiKey: STORED_KEY,
    });

    expect(update.apiKey).toBe(STORED_KEY);
    expect(poolsideSchema.safeParse(update).data?.apiKey).toBe(STORED_KEY);
  });

  test("a base URL that is not a URL is rejected rather than stored", async () => {
    const { toPoolsideUpdate } = await modulePromise;

    const update = toPoolsideUpdate({
      baseUrl: "pool.internal",
      binaryPath: "",
      apiKey: "",
    });

    expect(poolsideSchema.safeParse(update).success).toBe(false);
  });
});

describe("describeBackendLimitations", () => {
  test("names exactly the capabilities Poolside reports as unsupported", async () => {
    const { describeBackendLimitations } = await modulePromise;

    expect(
      new Set(
        describeBackendLimitations(POOLSIDE_CAPABILITIES).map(
          (entry) => entry.capability,
        ),
      ),
    ).toEqual(
      new Set([
        "effort",
        "images",
        "compaction",
        "customAgents",
        "structuredOutput",
      ]),
    );
  });

  /**
   * The whole point of the rewrite's second half. OpenFX advertised MCP and
   * session resume it did not have and took no model from the picker, so the
   * section warned about all three. Poolside supports them, and the copy has
   * to stop asserting losses that no longer exist — not because someone
   * deleted three strings, but because the list is derived.
   */
  test("says nothing about MCP, resume or steering, which Poolside supports", async () => {
    const { describeBackendLimitations } = await modulePromise;

    const text = describeBackendLimitations(POOLSIDE_CAPABILITIES)
      .map((entry) => entry.text)
      .join(" ");

    expect(text).not.toContain("MCP servers are not passed through");
    expect(text).not.toContain("fresh conversation");
    expect(text).not.toContain("cannot be steered");
  });

  /**
   * A non-empty `models` is a narrowing, not a loss: Poolside publishes two
   * `poolside/laguna-*` ids through `session/new`'s `configOptions`, so the
   * picker stays and must not be described as hidden.
   */
  test("treats a non-empty model list as a real picker, not a limitation", async () => {
    const { describeBackendLimitations } = await modulePromise;

    const capabilities = describeBackendLimitations(POOLSIDE_CAPABILITIES);
    expect(capabilities.map((entry) => entry.capability)).not.toContain(
      "models",
    );

    const noModels = describeBackendLimitations({
      ...POOLSIDE_CAPABILITIES,
      models: [],
    });
    expect(noModels.map((entry) => entry.capability)).toContain("models");
  });

  test("reads steering: none as a limitation, since it is not a boolean", async () => {
    const { describeBackendLimitations } = await modulePromise;

    const entries = describeBackendLimitations({
      ...POOLSIDE_CAPABILITIES,
      steering: "none",
    });

    expect(entries.map((entry) => entry.capability)).toContain("steering");
  });

  test("never reports the backend's id as a missing capability", async () => {
    const { describeBackendLimitations } = await modulePromise;

    const entries = describeBackendLimitations({
      ...POOLSIDE_CAPABILITIES,
      id: "none",
    });

    expect(entries.map((entry) => entry.capability)).not.toContain("id");
  });

  test("every line says something a reader can act on", async () => {
    const { describeBackendLimitations, POOLSIDE_LIMITATION_COPY } =
      await modulePromise;

    for (const entry of describeBackendLimitations(POOLSIDE_CAPABILITIES)) {
      expect(POOLSIDE_LIMITATION_COPY[entry.capability]).toBeDefined();
      expect(entry.text.length).toBeGreaterThan(20);
    }
  });

  test("a backend with no gaps produces no warnings at all", async () => {
    const { describeBackendLimitations } = await modulePromise;

    expect(
      describeBackendLimitations({
        id: "claude-code",
        resume: true,
        steering: "restart",
        mcp: true,
        effort: true,
        subagents: true,
        images: true,
        compaction: true,
      }),
    ).toEqual([]);
  });
});

describe("describeTestResult", () => {
  /**
   * The claim the green tick is allowed to make got stronger in exactly one
   * direction. `initialize` still does not authenticate — a locally
   * signed-in `pool` answers without the key — but it now echoes the
   * endpoint the binary resolved, which is the only way an operator can
   * catch the mistake this form is most likely to produce: a base URL that
   * is wrong but perfectly well-formed, against which the handshake
   * succeeds just as happily.
   */
  test("carries the resolved endpoint through, so the tick can be checked", async () => {
    const { describeTestResult } = await modulePromise;

    const result = describeTestResult({
      success: true,
      serviceMode: "provider: inference.poolside.ai",
    });

    expect(result.ok).toBe(true);
    expect(result.serviceMode).toBe("provider: inference.poolside.ai");
  });

  /**
   * The degrade path. An agent build that does not report the key must leave
   * the caller making the weaker claim — never an empty endpoint, which
   * would read as "it resolved nothing".
   */
  test("falls back to the weaker claim when no service mode is reported", async () => {
    const { describeTestResult } = await modulePromise;

    const result = describeTestResult({ success: true });

    expect(result.ok).toBe(true);
    expect(result.message).toBe(
      "Paco started the Poolside agent and it answered.",
    );
    expect(result.serviceMode).toBeUndefined();
  });

  test("treats an empty service mode as absent rather than rendering it", async () => {
    const { describeTestResult } = await modulePromise;

    expect(
      describeTestResult({ success: true, serviceMode: "" }).serviceMode,
    ).toBeUndefined();
  });

  test("never claims the key was checked", async () => {
    const { describeTestResult } = await modulePromise;

    const text = [
      describeTestResult({ success: true, serviceMode: "provider: x" }),
      describeTestResult({ success: true }),
    ]
      .map((entry) => entry.message)
      .join(" ")
      .toLowerCase();

    expect(text).not.toContain("key");
    expect(text).not.toContain("authenticated");
  });

  test("shows the server's reason for a failure, and its own when there is none", async () => {
    const { describeTestResult } = await modulePromise;

    expect(
      describeTestResult({ success: false, error: "pool: no such file" })
        .message,
    ).toBe("pool: no such file");
    expect(describeTestResult({ success: false }).message).toBe(
      "The Poolside agent refused the handshake.",
    );
  });

  test("never carries a service mode on a failed handshake", async () => {
    const { describeTestResult } = await modulePromise;

    expect(
      describeTestResult({ success: false, serviceMode: "provider: x" })
        .serviceMode,
    ).toBeUndefined();
  });
});
