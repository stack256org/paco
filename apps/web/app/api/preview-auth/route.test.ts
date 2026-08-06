import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { NextRequest } from "next/server";
import type { PreviewChatOwner } from "@/lib/preview/decide-access";

mock.module("server-only", () => ({}));

process.env.APP_SECRET ??= "test-secret-for-preview-auth-route-000000000";

type TestSession = { user: { id: string } } | undefined;

let chat: PreviewChatOwner | null | "throw";
let session: TestSession;
let previewBaseDomain: string | null;
let tlsEnabled: boolean;

const APP_ORIGIN = "https://paco.example.com";

mock.module("@/lib/preview/authorize", () => ({
  findChatOwnerByPreviewSlug: async () => {
    if (chat === "throw") {
      throw new Error("connection reset");
    }
    return chat;
  },
}));

mock.module("@/lib/session/server", () => ({
  getSessionFromReq: async () => session,
}));

mock.module("@/lib/settings/instance-settings", () => ({
  readInstanceSettings: async () => ({ previewBaseDomain, tlsEnabled }),
}));

// Spread the real module rather than replacing it outright: other,
// unmocked code reached from this route (`lib/config/required-env.ts`, via
// `secret-box.ts`) imports `isHttpUrlWithHost`/`appHost` from the same
// module, and a mock that provided only `appUrl` broke those imports for
// the whole process, not just this file's own use of `appUrl`.
const realAppUrl = await import("@/lib/app-url");
mock.module("@/lib/app-url", () => ({
  ...realAppUrl,
  appUrl: () => new URL(APP_ORIGIN),
}));

const routeModulePromise = import("./route");
const grantModulePromise = import("@/lib/preview/preview-grant");

function createRequest(params: {
  forwardedHost?: string;
  forwardedUri?: string;
  cookie?: string;
}): NextRequest {
  const headers = new Headers();
  if (params.forwardedHost !== undefined) {
    headers.set("x-forwarded-host", params.forwardedHost);
  }
  headers.set("x-forwarded-uri", params.forwardedUri ?? "/");

  const cookieMap = new Map<string, { value: string }>();
  if (params.cookie) {
    const [name, value] = params.cookie.split("=");
    if (name && value !== undefined) {
      cookieMap.set(name, { value });
    }
  }

  return {
    headers,
    cookies: { get: (name: string) => cookieMap.get(name) },
    url: "http://localhost/api/preview-auth",
  } as unknown as NextRequest;
}

describe("GET /api/preview-auth", () => {
  beforeEach(() => {
    chat = null;
    session = undefined;
    previewBaseDomain = "previews.example.com";
    tlsEnabled = true;
  });

  test("denies when X-Forwarded-Host is missing", async () => {
    const { GET } = await routeModulePromise;

    const response = await GET(createRequest({}));

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
  });

  test("denies a host that does not end in the configured base domain", async () => {
    const { GET } = await routeModulePromise;

    const response = await GET(
      createRequest({ forwardedHost: "chat-abc.attacker.example" }),
    );

    expect(response.status).toBe(401);
  });

  test("denies an unmappable host — no chat matches the slug", async () => {
    chat = null;
    const { GET } = await routeModulePromise;

    const response = await GET(
      createRequest({ forwardedHost: "no-such-chat.previews.example.com" }),
    );

    expect(response.status).toBe(401);
  });

  test("denies with a clean 401 when the chat lookup throws", async () => {
    chat = "throw";
    const { GET } = await routeModulePromise;

    const response = await GET(
      createRequest({ forwardedHost: "chat-abc.previews.example.com" }),
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
  });

  test("allows a public preview with no session", async () => {
    chat = {
      chatId: "chat-abc",
      ownerUserId: "owner-1",
      visibility: "public",
    };
    session = undefined;
    const { GET } = await routeModulePromise;

    const response = await GET(
      createRequest({ forwardedHost: "chat-abc.previews.example.com" }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  test("denies a private preview belonging to someone else", async () => {
    chat = {
      chatId: "chat-abc",
      ownerUserId: "owner-1",
      visibility: "private",
    };
    session = { user: { id: "someone-else" } };
    const { GET } = await routeModulePromise;

    const response = await GET(
      createRequest({ forwardedHost: "chat-abc.previews.example.com" }),
    );

    expect(response.status).toBe(401);
  });

  test("allows a private preview for its owner's session", async () => {
    chat = {
      chatId: "chat-abc",
      ownerUserId: "owner-1",
      visibility: "private",
    };
    session = { user: { id: "owner-1" } };
    const { GET } = await routeModulePromise;

    const response = await GET(
      createRequest({ forwardedHost: "chat-abc.previews.example.com" }),
    );

    expect(response.status).toBe(200);
  });

  test("strips the port before mapping the host to a slug", async () => {
    chat = {
      chatId: "chat-abc",
      ownerUserId: "owner-1",
      visibility: "public",
    };
    const { GET } = await routeModulePromise;

    const response = await GET(
      createRequest({ forwardedHost: "chat-abc.previews.example.com:443" }),
    );

    expect(response.status).toBe(200);
  });

  test("an unknown host and someone else's private preview are indistinguishable", async () => {
    const { GET } = await routeModulePromise;

    chat = null;
    session = undefined;
    const unknownHostResponse = await GET(
      createRequest({ forwardedHost: "no-such-chat.previews.example.com" }),
    );

    chat = {
      chatId: "chat-abc",
      ownerUserId: "owner-1",
      visibility: "private",
    };
    session = { user: { id: "someone-else" } };
    const notYoursResponse = await GET(
      createRequest({ forwardedHost: "chat-abc.previews.example.com" }),
    );

    expect(unknownHostResponse.status).toBe(notYoursResponse.status);
    expect(await unknownHostResponse.text()).toBe(
      await notYoursResponse.text(),
    );
    expect(await unknownHostResponse.text()).toBe("");
  });

  test("a private preview with no session and no grant redirects to the grant endpoint", async () => {
    chat = {
      chatId: "chat-abc",
      ownerUserId: "owner-1",
      visibility: "private",
    };
    session = undefined;
    const { GET } = await routeModulePromise;

    const response = await GET(
      createRequest({
        forwardedHost: "chat-abc.previews.example.com",
        forwardedUri: "/dashboard?x=1",
      }),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin).toBe(APP_ORIGIN);
    expect(location.pathname).toBe("/api/preview-auth/grant");
    expect(location.searchParams.get("host")).toBe(
      "chat-abc.previews.example.com",
    );
    expect(location.searchParams.get("returnTo")).toBe("/dashboard?x=1");
  });

  test("a valid grant cookie allows a private preview with no session at all", async () => {
    chat = {
      chatId: "chat-abc",
      ownerUserId: "owner-1",
      visibility: "private",
    };
    session = undefined;
    const { createPreviewGrantToken } = await grantModulePromise;
    const { token } = createPreviewGrantToken("chat-abc.previews.example.com");
    const { GET } = await routeModulePromise;

    const response = await GET(
      createRequest({
        forwardedHost: "chat-abc.previews.example.com",
        cookie: `paco_preview_grant=${token}`,
      }),
    );

    expect(response.status).toBe(200);
  });

  test("a grant cookie minted for a different host does not allow this one", async () => {
    chat = {
      chatId: "chat-abc",
      ownerUserId: "owner-1",
      visibility: "private",
    };
    session = undefined;
    const { createPreviewGrantToken } = await grantModulePromise;
    const { token } = createPreviewGrantToken(
      "some-other-chat.previews.example.com",
    );
    const { GET } = await routeModulePromise;

    const response = await GET(
      createRequest({
        forwardedHost: "chat-abc.previews.example.com",
        cookie: `paco_preview_grant=${token}`,
      }),
    );

    expect(response.status).toBe(302);
  });

  describe("consuming a grant token", () => {
    test("a valid token sets the grant cookie and redirects onward", async () => {
      chat = {
        chatId: "chat-abc",
        ownerUserId: "owner-1",
        visibility: "private",
      };
      const { createPreviewGrantToken } = await grantModulePromise;
      const { token } = createPreviewGrantToken(
        "chat-abc.previews.example.com",
      );
      const { GET } = await routeModulePromise;

      const response = await GET(
        createRequest({
          forwardedHost: "chat-abc.previews.example.com",
          forwardedUri: `/__paco-preview-auth/consume?grant=${encodeURIComponent(token)}&returnTo=%2Fdashboard`,
        }),
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(
        "https://chat-abc.previews.example.com/dashboard",
      );
      const setCookie = response.headers.get("Set-Cookie") ?? "";
      expect(setCookie).toContain(`paco_preview_grant=${token}`);
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("Secure");
    });

    test("an invalid token is denied, not redirected", async () => {
      const { GET } = await routeModulePromise;

      const response = await GET(
        createRequest({
          forwardedHost: "chat-abc.previews.example.com",
          forwardedUri: "/__paco-preview-auth/consume?grant=not-a-real-token",
        }),
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("Set-Cookie")).toBeNull();
    });

    test("omits Secure when TLS is off", async () => {
      tlsEnabled = false;
      const { createPreviewGrantToken } = await grantModulePromise;
      const { token } = createPreviewGrantToken(
        "chat-abc.previews.example.com",
      );
      const { GET } = await routeModulePromise;

      const response = await GET(
        createRequest({
          forwardedHost: "chat-abc.previews.example.com",
          forwardedUri: `/__paco-preview-auth/consume?grant=${encodeURIComponent(token)}`,
        }),
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(
        "http://chat-abc.previews.example.com/",
      );
      expect(response.headers.get("Set-Cookie") ?? "").not.toContain("Secure");
    });
  });
});
