import { beforeEach, describe, expect, mock, test } from "bun:test";
mock.module("server-only", () => ({}));

/**
 * The model list is static: the Claude Code CLI resolves a tier alias to the
 * current model in that tier, so there is no catalog to fetch and no metadata
 * to enrich. These tests cover what the route still decides — which tiers a
 * given session is allowed to see.
 */

let currentSession: {
  user: { id: string; email?: string; username?: string };
} | null = null;

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => currentSession,
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
  beforeEach(() => {
    currentSession = {
      user: {
        id: "user-1",
        email: "user@example.com",
        username: "user",
      },
    };
  });

  test("returns the Claude model tiers", async () => {
    const body = await getModels();

    expect(body.models.map((model) => model.id)).toEqual([
      "opus",
      "sonnet",
      "haiku",
    ]);
  });

  test("includes context window and cost for each tier", async () => {
    const body = await getModels();

    for (const model of body.models) {
      expect(model.context_window).toBeGreaterThan(0);
      expect(model.cost?.input).toBeGreaterThan(0);
      expect(model.cost?.output).toBeGreaterThan(0);
    }
  });

  test("serves the tier list without a session", async () => {
    // The list is three static tier names with no per-user data, so it is not
    // gated on auth.
    currentSession = null;

    const body = await getModels();

    expect(body.models.map((model) => model.id)).toEqual([
      "opus",
      "sonnet",
      "haiku",
    ]);
  });
});
