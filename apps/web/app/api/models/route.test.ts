import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
mock.module("server-only", () => ({}));

/**
 * The model list is static when talking to Anthropic directly: the Claude
 * Code CLI resolves a tier alias to the current model in that tier, so there
 * is no catalog to fetch and no metadata to enrich. It switches to the CLI's
 * own gateway discovery cache once a base URL is configured — see
 * `lib/model-catalog.test.ts` for that behaviour in detail. This file only
 * has to prove the route actually reads the configured base URL and wires it
 * through, and that the fallback survives the trip.
 */

let claudeBaseUrl: string | null = null;

mock.module("@/lib/settings/instance-settings", () => ({
  readInstanceSettings: () =>
    Promise.resolve({
      appDomain: null,
      tlsEnabled: false,
      previewBaseDomain: null,
      claudeCredentialKind: null,
      claudeCredentialSetAt: null,
      claudeBaseUrl,
      claudeModelDiscovery: false,
    }),
}));

const routeModulePromise = import("./route");

interface ModelsResponse {
  models: Array<{
    id: string;
    name: string;
    context_window?: number;
    cost?: { input?: number; output?: number };
  }>;
}

async function getModels(): Promise<ModelsResponse> {
  const { GET } = await routeModulePromise;
  const response = await GET();
  return (await response.json()) as ModelsResponse;
}

describe("/api/models", () => {
  test("returns the Claude model tiers", async () => {
    const body = await getModels();

    const ids = body.models.map((model) => model.id);

    for (const id of ["opus", "sonnet", "haiku"]) {
      expect(ids).toContain(id);
    }
  });

  test("includes context window and cost for each Claude tier", async () => {
    const body = await getModels();
    const tiers = body.models.filter((model) =>
      ["opus", "sonnet", "haiku"].includes(model.id),
    );

    expect(tiers).toHaveLength(3);
    for (const model of tiers) {
      expect(model.context_window).toBeGreaterThan(0);
      expect(model.cost?.input).toBeGreaterThan(0);
      expect(model.cost?.output).toBeGreaterThan(0);
    }
  });

  describe("with a gateway configured", () => {
    let previousHome: string | undefined;
    let previousBaseUrl: string | null;
    let tempHome: string;

    beforeEach(() => {
      previousBaseUrl = claudeBaseUrl;
      claudeBaseUrl = "https://llm.example.com";

      // An isolated, empty $HOME: this instance's gateway has never been
      // queried by the CLI, so no discovery cache exists yet. Not
      // PACO_HOME — the cache path is keyed off the CLI's own $HOME, which
      // model-catalog.ts's `gatewayModelCachePath` deliberately does not
      // conflate with Paco's own data directory.
      previousHome = process.env.HOME;
      tempHome = mkdtempSync(join(tmpdir(), "paco-api-models-test-"));
      process.env.HOME = tempHome;
    });

    afterEach(() => {
      claudeBaseUrl = previousBaseUrl;
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      rmSync(tempHome, { recursive: true, force: true });
    });

    /**
     * The property this task exists to close: a base URL saved in Settings
     * must reach `listClaudeModels`, and its fallback must survive the trip
     * through the route — an operator who has just configured a gateway, and
     * whose CLI has not queried it yet, must still see a populated picker
     * rather than an empty one.
     */
    test("still returns the tier aliases when the CLI hasn't cached a discovery response yet", async () => {
      const body = await getModels();

      const ids = body.models.map((model) => model.id);
      expect(ids).toEqual(["opus", "sonnet", "haiku"]);
    });
  });
});
