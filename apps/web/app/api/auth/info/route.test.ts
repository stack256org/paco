import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NextRequest } from "next/server";

mock.module("server-only", () => ({}));

type TestSession = {
  user: {
    id: string;
    username: string;
    email?: string;
  };
} | null;

let session: TestSession;
let exists = true;
let hasGitHubLinked = false;
let isAdmin = false;

const originalNodeEnv = process.env.NODE_ENV;

mock.module("@/lib/session/server", () => ({
  getSessionFromReq: async () => session,
}));

mock.module("@/lib/db/users", () => ({
  userExists: async () => exists,
}));

mock.module("@/lib/admin/require-admin", () => ({
  isAdmin: async () => isAdmin,
}));

mock.module("@/lib/db/github-tokens", () => ({
  getGithubConnection: async () =>
    hasGitHubLinked
      ? {
          login: "octocat",
          githubUserId: 1,
          scopes: ["repo"],
          connectedAt: new Date(),
        }
      : null,
}));

const routeModulePromise = import("./route");

function createRequest(url = "http://localhost/api/auth/info"): NextRequest {
  return {
    nextUrl: new URL(url),
    url,
  } as NextRequest;
}

describe("GET /api/auth/info", () => {
  afterEach(() => {
    Object.assign(process.env, { NODE_ENV: originalNodeEnv });
  });

  beforeEach(() => {
    session = {
      user: {
        id: "user-1",
        username: "test-user",
        email: "person@example.com",
      },
    };
    exists = true;
    hasGitHubLinked = false;
    isAdmin = false;
  });

  test("returns unauthenticated when there is no session", async () => {
    session = null;
    const { GET } = await routeModulePromise;

    const response = await GET(createRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
  });

  test("returns unauthenticated when the user record is gone", async () => {
    exists = false;
    const { GET } = await routeModulePromise;

    const response = await GET(createRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
  });

  test("reports a connected GitHub account", async () => {
    hasGitHubLinked = true;
    const { GET } = await routeModulePromise;

    const response = await GET(createRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user: session?.user,
      isAdmin: false,
      hasGitHub: true,
      githubLogin: "octocat",
    });
  });

  test("reports no GitHub connection", async () => {
    const { GET } = await routeModulePromise;

    const response = await GET(createRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user: session?.user,
      isAdmin: false,
      hasGitHub: false,
      githubLogin: null,
    });
  });
});
