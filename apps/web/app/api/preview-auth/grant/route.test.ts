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

// Matches strictly on the BASE chat slug ("chat-abc"), never on a
// candidate label ("chat-abc-d2") — this is what makes the
// design-candidate tests below actually exercise `parsePreviewHostSlug`
// inside route.ts, instead of a mock that returns `chat` regardless of
// what slug it was called with (which would pass even if the route
// regressed to looking a candidate host up by its raw, unstripped label —
// exactly the bug `chats.previewSlug` being a generated column with no
// `-d<n>` suffix would otherwise hide).
mock.module("@/lib/preview/authorize", () => ({
  findChatOwnerByPreviewSlug: async (slug: string) =>
    slug === "chat-abc" ? chat : null,
}));

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => session,
}));

// Only `/api/preview-auth/route.ts` (not this grant endpoint) reads a
// session this way — mocked here purely so the round-trip tests below can
// exercise that route too, in-process, against the grant this endpoint
// mints.
mock.module("@/lib/session/server", () => ({
  getSessionFromReq: async () => session,
}));

mock.module("@/lib/settings/instance-settings", () => ({
  readInstanceSettings: async () => ({ previewBaseDomain, tlsEnabled }),
}));

const routeModulePromise = import("./route");
const previewAuthRouteModulePromise = import("../route");
const previewGrantModulePromise = import("@/lib/preview/preview-grant");

function createRequest(url: string): NextRequest {
  return { url } as NextRequest;
}

/** A minimal fake of what `/api/preview-auth/route.ts`'s GET reads off a `NextRequest`. */
function createForwardAuthRequest(params: {
  forwardedHost: string;
  cookie?: string;
}): NextRequest {
  const headers = new Headers();
  headers.set("x-forwarded-host", params.forwardedHost);
  headers.set("x-forwarded-uri", "/");

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

  describe("design-candidate hosts (a private chat's `<slug>-d<n>` preview)", () => {
    // Regression coverage for the bug this suite's `findChatOwnerByPreviewSlug`
    // mock (above) was tightened to catch: this endpoint used to pass a
    // candidate host's raw, unstripped label (e.g. "chat-abc-d2") straight
    // into `findChatOwnerByPreviewSlug`, which always misses — `chats.previewSlug`
    // is a generated column that never carries a `-d<n>` suffix — so an
    // owner could never mint a grant for a private chat's candidate preview
    // at all. `route.ts` (this endpoint) must resolve the BASE chat slug
    // first; the token it mints must still bind to the FULL candidate host.

    test("mints a grant for the owner, bound to the full candidate host (not the base chat's)", async () => {
      session = { user: { id: "owner-1" } };
      chat = {
        chatId: "chat-abc",
        ownerUserId: "owner-1",
        visibility: "private",
      };
      const { GET } = await routeModulePromise;

      const response = await GET(
        createRequest(
          "https://paco.example.com/api/preview-auth/grant?host=chat-abc-d2.previews.example.com&returnTo=%2Ffoo",
        ),
      );

      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("Location") ?? "");
      expect(location.origin).toBe("https://chat-abc-d2.previews.example.com");
      expect(location.pathname).toBe("/__paco-preview-auth/consume");
      const grant = location.searchParams.get("grant");
      expect(grant).toBeTruthy();

      const { verifyPreviewGrantToken } = await previewGrantModulePromise;
      // Bound to the candidate's own full host — not the base chat's host,
      // and not usable against any other candidate of the same chat.
      expect(
        verifyPreviewGrantToken(grant, "chat-abc-d2.previews.example.com"),
      ).toBe(true);
      expect(
        verifyPreviewGrantToken(grant, "chat-abc.previews.example.com"),
      ).toBe(false);
      expect(
        verifyPreviewGrantToken(grant, "chat-abc-d3.previews.example.com"),
      ).toBe(false);
    });

    test("403s for a candidate host when the session isn't the chat's owner", async () => {
      session = { user: { id: "someone-else" } };
      chat = {
        chatId: "chat-abc",
        ownerUserId: "owner-1",
        visibility: "private",
      };
      const { GET } = await routeModulePromise;

      const response = await GET(
        createRequest(
          "https://paco.example.com/api/preview-auth/grant?host=chat-abc-d2.previews.example.com",
        ),
      );

      expect(response.status).toBe(403);
    });

    test("real round trip: owner mints a grant for a candidate host, then preview-auth allows it on the grant alone", async () => {
      session = { user: { id: "owner-1" } };
      chat = {
        chatId: "chat-abc",
        ownerUserId: "owner-1",
        visibility: "private",
      };
      const { GET: mintGrant } = await routeModulePromise;
      const { GET: forwardAuth } = await previewAuthRouteModulePromise;

      const mintResponse = await mintGrant(
        createRequest(
          "https://paco.example.com/api/preview-auth/grant?host=chat-abc-d2.previews.example.com",
        ),
      );
      expect(mintResponse.status).toBe(302);
      const consumeLocation = new URL(
        mintResponse.headers.get("Location") ?? "",
      );
      const grant = consumeLocation.searchParams.get("grant");
      expect(grant).toBeTruthy();

      // The preview host itself never carries Paco's own session cookie
      // (host-only, by design) — dropping `session` to `undefined` here is
      // what makes this an honest test of the grant mechanism rather than
      // one that would pass on session alone.
      session = undefined;

      const allowedResponse = await forwardAuth(
        createForwardAuthRequest({
          forwardedHost: "chat-abc-d2.previews.example.com",
          cookie: `paco_preview_grant=${grant}`,
        }),
      );
      expect(allowedResponse.status).toBe(200);
    });

    test("real round trip: a non-owner can never mint a grant, so forward-auth keeps denying them", async () => {
      chat = {
        chatId: "chat-abc",
        ownerUserId: "owner-1",
        visibility: "private",
      };
      session = { user: { id: "someone-else" } };
      const { GET: mintGrant } = await routeModulePromise;
      const { GET: forwardAuth } = await previewAuthRouteModulePromise;

      const mintResponse = await mintGrant(
        createRequest(
          "https://paco.example.com/api/preview-auth/grant?host=chat-abc-d2.previews.example.com",
        ),
      );
      expect(mintResponse.status).toBe(403);

      const deniedResponse = await forwardAuth(
        createForwardAuthRequest({
          forwardedHost: "chat-abc-d2.previews.example.com",
        }),
      );
      // No session cookie carried on the preview host either way, but the
      // point stands: with no valid grant, a stranger to a private chat's
      // candidate is never allowed.
      expect(deniedResponse.status).not.toBe(200);
    });
  });
});
