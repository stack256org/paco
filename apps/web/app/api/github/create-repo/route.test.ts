import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CreatedRepo } from "@/lib/github/gh-repo";

mock.module("server-only", () => ({}));

let storedToken: string | null;
let sessionRecord: {
  sandboxState: { sandboxName: string } | null;
} | null;
let createResult: CreatedRepo | Error;
let createCalls: Array<Record<string, unknown>>;
let sessionUpdates: Array<Record<string, unknown>>;

mock.module("@/lib/db/github-tokens", () => ({
  getGithubToken: async () => storedToken,
}));

mock.module("@/lib/db/sessions", () => ({
  getSessionById: async () => sessionRecord,
  updateSession: async (_id: string, values: Record<string, unknown>) => {
    sessionUpdates.push(values);
  },
}));

mock.module("@paco/sandbox", () => ({
  repoDir: (root: string) => `${root}/repo`,
  workspaceRoot: () => "/tmp/paco-workspaces",
  chatWorktreePath: (chatId: string) => `chats/${chatId}`,
}));

mock.module("@/lib/github/gh-repo", () => ({
  createRepoFromLocal: async (params: Record<string, unknown>) => {
    createCalls.push(params);
    if (createResult instanceof Error) {
      throw createResult;
    }
    return createResult;
  },
}));

const { GhError } = await import("@/lib/github/gh");
const routeModulePromise = import("./route");

const REPO: CreatedRepo = {
  owner: "octocat",
  name: "hello-world",
  nameWithOwner: "octocat/hello-world",
  htmlUrl: "https://github.com/octocat/hello-world",
  cloneUrl: "https://github.com/octocat/hello-world.git",
  defaultBranch: "main",
};

function createRequest(body: unknown): Request {
  return new Request("http://localhost/api/github/create-repo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const VALID = {
  sessionId: "session-1",
  repoName: "hello-world",
  isPrivate: true,
};

describe("/api/github/create-repo", () => {
  beforeEach(() => {
    storedToken = "ghp_test";
    sessionRecord = {
      sandboxState: { sandboxName: "session_1" },
    };
    createResult = REPO;
    createCalls = [];
    sessionUpdates = [];
  });

  test("rejects a body that is not valid JSON", async () => {
    const { POST } = await routeModulePromise;

    expect((await POST(createRequest("not-json"))).status).toBe(400);
  });

  test("rejects a repository name GitHub would not accept", async () => {
    // Caught here so the user is told immediately, rather than after a round
    // trip that then has to be undone.
    const { POST } = await routeModulePromise;

    const response = await POST(
      createRequest({ ...VALID, repoName: "not valid/name" }),
    );

    expect(response.status).toBe(400);
    expect(createCalls).toHaveLength(0);
  });

  test("asks the user to connect GitHub when no token is stored", async () => {
    storedToken = null;
    const { POST } = await routeModulePromise;

    const response = await POST(createRequest(VALID));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(
      "Connect your GitHub account",
    );
  });

  test("returns 404 when the session does not exist", async () => {
    sessionRecord = null;
    const { POST } = await routeModulePromise;

    expect((await POST(createRequest(VALID))).status).toBe(404);
    expect(createCalls).toHaveLength(0);
  });

  test("creates the repository from the session's repo directory", async () => {
    // Not a chat worktree: publishing a session publishes its default branch,
    // and a worktree only has one chat's branch checked out.
    const { POST } = await routeModulePromise;

    const response = await POST(createRequest(VALID));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      repoUrl: REPO.htmlUrl,
      owner: REPO.owner,
      repoName: REPO.name,
      cloneUrl: REPO.cloneUrl,
      branch: REPO.defaultBranch,
    });
    expect(createCalls[0]?.cwd).toBe("/tmp/paco-workspaces/session_1/repo");
  });

  test("records the repository on the session", async () => {
    // Without this the session has no remote for a later push, and the sidebar
    // keeps filing it under "Workspaces".
    const { POST } = await routeModulePromise;

    await POST(createRequest(VALID));

    expect(sessionUpdates[0]).toEqual({
      repoOwner: REPO.owner,
      repoName: REPO.name,
      cloneUrl: REPO.cloneUrl,
    });
  });

  test("passes gh's own explanation through to the user", async () => {
    // "Name already exists on this account" is more useful than anything this
    // route could invent.
    createResult = new GhError(
      "gh repo failed: Name already exists on this account",
      "failed",
      1,
      "",
    );
    const { POST } = await routeModulePromise;

    const response = await POST(createRequest(VALID));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("already exists");
    expect(sessionUpdates).toHaveLength(0);
  });

  test("reports a missing CLI as unavailable, not as a bad request", async () => {
    createResult = new GhError("gh is not installed", "missing", null, "");
    const { POST } = await routeModulePromise;

    expect((await POST(createRequest(VALID))).status).toBe(503);
  });
});
