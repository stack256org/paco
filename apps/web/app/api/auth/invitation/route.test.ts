import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

let email: string | null = null;
let lastTokenSeen: string | null = null;

mock.module("@/lib/org/invitations", () => ({
  findLiveInvitationEmailByToken: async (token: string) => {
    lastTokenSeen = token;
    return email;
  },
}));

/**
 * Reads `lastTokenSeen` through an explicitly-typed function rather than as
 * a bare identifier.
 *
 * It's reassigned inside the `mock.module` closure above, from the route
 * handler this file awaits. TypeScript narrows a captured `let` to whatever
 * literal it was last assigned in this scope and does not widen it back
 * across the intervening `await`, so `expect(lastTokenSeen).toBe("tok-live")`
 * fails to type-check even though the mock has run by the time this line
 * executes. Routing the read through a function whose return type is
 * declared, not inferred from narrowing, gets the true `string | null` type.
 */
function currentValue(get: () => string | null): string | null {
  return get();
}

const routeModulePromise = import("./route");

function getRequest(query: string): Request {
  return new Request(`http://localhost:3066/api/auth/invitation${query}`);
}

describe("GET /api/auth/invitation", () => {
  test("resolves a live token to its invited address", async () => {
    email = "invited@corp.com";
    lastTokenSeen = null;
    const { GET } = await routeModulePromise;

    const response = await GET(getRequest("?token=tok-live"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: "invited@corp.com" });
    expect(currentValue(() => lastTokenSeen)).toBe("tok-live");
  });

  test("degrades to email: null for an unknown, expired, or accepted token", async () => {
    email = null;
    const { GET } = await routeModulePromise;

    const response = await GET(getRequest("?token=tok-does-not-exist"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: null });
  });

  test("degrades to email: null when no token is given, without ever calling the lookup", async () => {
    lastTokenSeen = null;
    const { GET } = await routeModulePromise;

    const response = await GET(getRequest(""));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: null });
    expect(lastTokenSeen).toBeNull();
  });

  test("never leaks the token or anything beyond the email in the response shape", async () => {
    email = "invited@corp.com";
    const { GET } = await routeModulePromise;

    const response = await GET(getRequest("?token=tok-live"));
    const body = await response.json();

    expect(Object.keys(body)).toEqual(["email"]);
  });
});
