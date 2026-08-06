import { describe, expect, test } from "bun:test";
import { redirectAuthErrorsToLandingPage } from "./redirect-auth-errors";

const NAVIGATION = new Request(
  "http://localhost:3066/api/auth/magic-link/verify",
  {
    headers: { accept: "text/html,application/xhtml+xml" },
  },
);

const FETCH = new Request("http://localhost:3066/api/auth/magic-link/verify", {
  headers: { accept: "application/json" },
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("redirectAuthErrorsToLandingPage", () => {
  test("sends a refused navigation to the landing page with the code", async () => {
    const result = await redirectAuthErrorsToLandingPage(
      NAVIGATION,
      jsonResponse({ code: "SIGNUP_DISABLED", message: "Nope." }, 403),
    );

    expect(result.status).toBe(303);
    const location = new URL(result.headers.get("location") ?? "");
    expect(location.pathname).toBe("/");
    expect(location.searchParams.get("error")).toBe("SIGNUP_DISABLED");
  });

  test("leaves a JSON caller's response completely alone", async () => {
    const original = jsonResponse({ code: "SIGNUP_DISABLED" }, 403);
    const result = await redirectAuthErrorsToLandingPage(FETCH, original);

    expect(result).toBe(original);
    expect(result.status).toBe(403);
    // The body must still be readable — the wrapper reads a clone, never the
    // response it hands back.
    expect(await result.json()).toEqual({ code: "SIGNUP_DISABLED" });
  });

  test("leaves a successful response alone", async () => {
    const original = jsonResponse({ status: true }, 200);
    expect(await redirectAuthErrorsToLandingPage(NAVIGATION, original)).toBe(
      original,
    );
  });

  test("does not overrule a route that already redirects", async () => {
    const original = new Response(null, {
      headers: { location: "/sessions" },
      status: 302,
    });

    expect(await redirectAuthErrorsToLandingPage(NAVIGATION, original)).toBe(
      original,
    );
  });

  test("leaves a server error alone, since it carries no code to explain", async () => {
    const original = jsonResponse({ message: "boom" }, 500);
    expect(await redirectAuthErrorsToLandingPage(NAVIGATION, original)).toBe(
      original,
    );
  });

  test("leaves a non-JSON body alone", async () => {
    const original = new Response("not json", { status: 403 });
    expect(await redirectAuthErrorsToLandingPage(NAVIGATION, original)).toBe(
      original,
    );
  });

  test("leaves a JSON body with no code alone", async () => {
    const original = jsonResponse({ message: "no code here" }, 403);
    expect(await redirectAuthErrorsToLandingPage(NAVIGATION, original)).toBe(
      original,
    );
  });
});
