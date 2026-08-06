import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { NextRequest } from "next/server";
import type { PreviewChatOwner } from "@/lib/preview/decide-access";

mock.module("server-only", () => ({}));

process.env.APP_SECRET ??= "test-secret-for-preview-grant-route-00000000";

type TestSession = { user: { id: string } } | undefined;

let chat: PreviewChatOwner | null;
let session: TestSession;
let previewBaseDomain: string | null;
let tlsEnabled: boolean;

mock.module("@/lib/preview/authorize", () => ({
  findChatOwnerByPreviewSlug: async () => chat,
}));

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => session,
}));

mock.module("@/lib/settings/instance-settings", () => ({
  readInstanceSettings: async () => ({ previewBaseDomain, tlsEnabled }),
}));

const routeModulePromise = import("./route");

function createRequest(url: string): NextRequest {
  return { url } as NextRequest;
}

describe("GET /api/preview-auth/grant", () => {
  beforeEach(() => {
    chat = null;
    session = undefined;
    previewBaseDomain = "previews.example.com";
    tlsEnabled = true;
  });

  test("400s with no host", async () => {
    const { GET } = await routeModulePromise;
    const response = await GET(
      createRequest("https://paco.example.com/api/preview-auth/grant"),
    );
    expect(response.status).toBe(400);
  });

  test("400s for a host outside the configured base domain", async () => {
    const { GET } = await routeModulePromise;
    const response = await GET(
      createRequest(
        "https://paco.example.com/api/preview-auth/grant?host=chat-abc.attacker.example",
      ),
    );
    expect(response.status).toBe(400);
  });

  test("401s with no session", async () => {
    session = undefined;
    const { GET } = await routeModulePromise;
    const response = await GET(
      createRequest(
        "https://paco.example.com/api/preview-auth/grant?host=chat-abc.previews.example.com",
      ),
    );
    expect(response.status).toBe(401);
  });

  test("404s when the chat no longer exists", async () => {
    session = { user: { id: "owner-1" } };
    chat = null;
    const { GET } = await routeModulePromise;
    const response = await GET(
      createRequest(
        "https://paco.example.com/api/preview-auth/grant?host=chat-abc.previews.example.com",
      ),
    );
    expect(response.status).toBe(404);
  });

  test("403s when the session isn't the chat's owner", async () => {
    session = { user: { id: "someone-else" } };
    chat = {
      chatId: "chat-abc",
      ownerUserId: "owner-1",
      visibility: "private",
    };
    const { GET } = await routeModulePromise;
    const response = await GET(
      createRequest(
        "https://paco.example.com/api/preview-auth/grant?host=chat-abc.previews.example.com",
      ),
    );
    expect(response.status).toBe(403);
  });

  test("redirects straight back for a chat that has since gone public, minting no token", async () => {
    session = { user: { id: "owner-1" } };
    chat = { chatId: "chat-abc", ownerUserId: "owner-1", visibility: "public" };
    const { GET } = await routeModulePromise;
    const response = await GET(
      createRequest(
        "https://paco.example.com/api/preview-auth/grant?host=chat-abc.previews.example.com&returnTo=%2Ffoo",
      ),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://chat-abc.previews.example.com/foo",
    );
  });

  test("redirects the owner to the consume path with a grant token", async () => {
    session = { user: { id: "owner-1" } };
    chat = {
      chatId: "chat-abc",
      ownerUserId: "owner-1",
      visibility: "private",
    };
    const { GET } = await routeModulePromise;
    const response = await GET(
      createRequest(
        "https://paco.example.com/api/preview-auth/grant?host=chat-abc.previews.example.com&returnTo=%2Ffoo",
      ),
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin).toBe("https://chat-abc.previews.example.com");
    expect(location.pathname).toBe("/__paco-preview-auth/consume");
    expect(location.searchParams.get("grant")).toBeTruthy();
    expect(location.searchParams.get("returnTo")).toBe("/foo");
  });

  test("ignores an unsafe returnTo and falls back to /", async () => {
    session = { user: { id: "owner-1" } };
    chat = {
      chatId: "chat-abc",
      ownerUserId: "owner-1",
      visibility: "private",
    };
    const { GET } = await routeModulePromise;
    const response = await GET(
      createRequest(
        "https://paco.example.com/api/preview-auth/grant?host=chat-abc.previews.example.com&returnTo=%2F%2Fevil.example",
      ),
    );
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.searchParams.get("returnTo")).toBe("/");
  });
});
