import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

// The default Origin these requests carry. The route no longer reads APP_URL
// at all — what it compares against is the domain configured in settings, which
// `configuredDomain` below stands in for — but requests still need *some*
// origin, and one that matches the request URL keeps the fixtures realistic.
const APP_ORIGIN = "http://localhost:3066";

let firstRun = true;

mock.module("@/lib/auth/first-run", () => ({
  isFirstRun: async () => firstRun,
}));

/**
 * The domain the instance has been configured with, which is what decides
 * whether the origin check enforces anything at all. `null` is a fresh install
 * — the state every one of these starts in unless it says otherwise.
 */
let configuredDomain: string | null = null;

mock.module("@/lib/settings/instance-settings", () => ({
  readInstanceSettings: async () => ({ appDomain: configuredDomain }),
}));

type CaptureMetadata = { captureToken?: (token: string) => void };

let capturedEmail: string | null = null;
let signInThrows: Error | null = null;
let verifyStatus = 200;
let verifyThrows: Error | null = null;

mock.module("@/lib/auth/config", () => ({
  auth: {
    api: {
      signInMagicLink: async ({
        body,
      }: {
        body: { email: string; metadata: CaptureMetadata };
      }) => {
        capturedEmail = body.email;
        if (signInThrows) {
          throw signInThrows;
        }
        body.metadata.captureToken?.("captured-test-token");
      },
      magicLinkVerify: async () => {
        if (verifyThrows) {
          throw verifyThrows;
        }
        return new Response(
          JSON.stringify({ token: "t", user: {}, session: {} }),
          {
            headers: { "set-cookie": "auth-session=abc; Path=/" },
            status: verifyStatus,
          },
        );
      },
    },
  },
}));

let renamedTo: string | null = null;
mock.module("@/lib/org/organization", () => ({
  renameOrganization: async (name: string) => {
    renamedTo = name;
  },
}));

/**
 * Reads `capturedEmail`/`renamedTo` through an explicitly-typed function
 * rather than as a bare identifier.
 *
 * Both are reassigned inside the `mock.module` closures above, from a route
 * handler this file awaits. TypeScript narrows a captured `let` to whatever
 * literal it was last assigned in this scope (`null`, at the top of most
 * tests) and does not widen it back across the intervening `await`, so
 * `expect(capturedEmail).toBe("owner@corp.com")` fails to type-check even
 * though the mock has run and set a real value by the time this line
 * executes. Routing the read through a function whose return type is
 * declared, not inferred from narrowing, gets the true `string | null` type.
 */
function currentValue(get: () => string | null): string | null {
  return get();
}

const routeModulePromise = import("./route");

function postRequest(
  body: unknown,
  origin: string | null = APP_ORIGIN,
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (origin) {
    headers.set("origin", origin);
  }
  return new Request("http://localhost:3066/api/auth/first-run", {
    body: JSON.stringify(body),
    headers,
    method: "POST",
  });
}

describe("GET /api/auth/first-run", () => {
  test("reports true when no account exists yet", async () => {
    firstRun = true;
    const { GET } = await routeModulePromise;

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ firstRun: true });
  });

  test("reports false once an account exists", async () => {
    firstRun = false;
    const { GET } = await routeModulePromise;

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ firstRun: false });
  });
});

describe("POST /api/auth/first-run", () => {
  test("claims a fresh install from whatever address reached it", async () => {
    // The bug this covers made every default install unclaimable, twice over.
    //
    // `curl | sudo sh` has no terminal, so the installer's domain prompt is
    // always skipped and no domain is ever configured. Judging the browser's
    // Origin in that state — first against APP_URL's localhost fallback, then
    // against a Host any edge proxy rewrites — refused every real address, and
    // there was no address that worked.
    //
    // An instance that has not been told its own address accepts any.
    configuredDomain = null;
    firstRun = true;
    capturedEmail = null;
    const { POST } = await routeModulePromise;

    const response = await POST(
      postRequest({ email: "owner@example.com" }, "https://paco.2sc.dev"),
    );

    expect(response.status).toBe(200);
    expect(currentValue(() => capturedEmail)).toBe("owner@example.com");
  });

  test("accepts a request with no Origin at all while unconfigured", async () => {
    configuredDomain = null;
    firstRun = true;
    capturedEmail = null;
    const { POST } = await routeModulePromise;

    const response = await POST(
      postRequest({ email: "owner@example.com" }, null),
    );

    expect(response.status).toBe(200);
    expect(currentValue(() => capturedEmail)).toBe("owner@example.com");
  });

  test("rejects a foreign Origin once a domain is configured", async () => {
    configuredDomain = "https://paco.2sc.dev";
    firstRun = true;
    capturedEmail = null;
    const { POST } = await routeModulePromise;

    const response = await POST(
      postRequest({ email: "attacker@evil.com" }, "https://evil.example"),
    );

    configuredDomain = null;

    expect(response.status).toBe(403);
    // Never even reached the point of starting a sign-in.
    expect(capturedEmail).toBeNull();
  });

  test("rejects a host that merely extends the configured domain", async () => {
    // A suffix match is the classic way an origin check is got wrong.
    configuredDomain = "https://paco.2sc.dev";
    firstRun = true;
    capturedEmail = null;
    const { POST } = await routeModulePromise;

    const response = await POST(
      postRequest(
        { email: "attacker@evil.com" },
        "https://paco.2sc.dev.evil.example",
      ),
    );

    configuredDomain = null;

    expect(response.status).toBe(403);
    expect(capturedEmail).toBeNull();
  });

  test("refuses to claim an already-claimed instance, even from the app's own origin", async () => {
    firstRun = false;
    capturedEmail = null;
    const { POST } = await routeModulePromise;

    const response = await POST(postRequest({ email: "someone@corp.com" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "This instance already has an account. Ask an administrator for an invitation.",
    });
    expect(capturedEmail).toBeNull();
  });

  test("rejects an invalid email", async () => {
    firstRun = true;
    const { POST } = await routeModulePromise;

    const response = await POST(postRequest({ email: "not-an-email" }));

    expect(response.status).toBe(400);
  });

  test("claims a fresh instance from its own origin, carrying forward the session cookie", async () => {
    firstRun = true;
    capturedEmail = null;
    renamedTo = null;
    verifyStatus = 200;
    verifyThrows = null;
    signInThrows = null;
    const { POST } = await routeModulePromise;

    const response = await POST(
      postRequest({
        email: "owner@corp.com",
        organizationName: "Acme",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(response.headers.get("set-cookie")).toBe("auth-session=abc; Path=/");
    expect(currentValue(() => capturedEmail)).toBe("owner@corp.com");
    expect(currentValue(() => renamedTo)).toBe("Acme");
  });

  test("passes through a failed verification response instead of claiming success", async () => {
    firstRun = true;
    verifyStatus = 401;
    verifyThrows = null;
    const { POST } = await routeModulePromise;

    const response = await POST(postRequest({ email: "owner@corp.com" }));

    expect(response.status).toBe(401);
  });
});
