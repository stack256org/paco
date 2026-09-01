import { describe, expect, mock, test } from "bun:test";
mock.module("server-only", () => ({}));

/**
 * The model list is static: the Claude Code CLI resolves a tier alias to the
 * current model in that tier, and Poolside's ids come from its package
 * constant, so there is no catalog to fetch and no metadata to enrich.
 */

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

  /**
   * The composer swaps its server-rendered options for this response, then
   * filters them client-side against the chat's `capabilities.models`. If
   * this route answered with one backend's models, switching a chat to the
   * other would leave the picker with nothing to reveal.
   */
  test("also returns the models of the second backend, so a switched chat has something to pick", async () => {
    const { POOLSIDE_MODEL_IDS } = await import("@paco/poolside-backend");

    const body = await getModels();
    const ids = body.models.map((model) => model.id);

    for (const id of POOLSIDE_MODEL_IDS) {
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
});
