import { describe, expect, mock, test } from "bun:test";
mock.module("server-only", () => ({}));

/**
 * The model list is static: the Claude Code CLI resolves a tier alias to the
 * current model in that tier, so there is no catalog to fetch and no
 * metadata to enrich.
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
