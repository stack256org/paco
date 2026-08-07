import { describe, expect, test } from "bun:test";
import { isClaimOriginAllowed } from "./origin-policy";

/**
 * The rule, in one sentence: an instance that has not been told its own
 * address is in no position to judge anyone else's.
 *
 * Two earlier attempts both locked operators out of their own fresh installs.
 * The first compared Origin against `APP_URL`, which a piped install never
 * sets — so it fell back to `http://localhost:3000` and refused every real
 * address. The second compared Origin against the request's own Host, which is
 * right in principle and still wrong behind an edge proxy that rewrites Host:
 * the browser is on one name, the app sees another, and they never match.
 *
 * Both were the same mistake — enforcing an identity the instance does not
 * have yet. Nothing is protected by it either: while an instance is unclaimed,
 * anyone who can reach it can claim it, with or without a browser.
 */
describe("isClaimOriginAllowed", () => {
  describe("before a domain is configured", () => {
    test("accepts a browser on the host's IP", () => {
      expect(isClaimOriginAllowed("http://198.18.1.16", null)).toBe(true);
    });

    test("accepts a browser on a domain pointed here", () => {
      expect(isClaimOriginAllowed("https://paco.2sc.dev", null)).toBe(true);
    });

    test("accepts a request with no Origin at all", () => {
      // curl, a health check, anything without a browser. There is nothing to
      // compare it against, and refusing it protects nothing.
      expect(isClaimOriginAllowed(null, null)).toBe(true);
    });

    test("treats a blank configured domain as unconfigured", () => {
      expect(isClaimOriginAllowed("https://anything.example", "  ")).toBe(true);
    });
  });

  describe("once a domain is configured", () => {
    test("accepts the configured domain", () => {
      expect(
        isClaimOriginAllowed("https://paco.2sc.dev", "https://paco.2sc.dev"),
      ).toBe(true);
    });

    test("accepts it over a different scheme", () => {
      // The edge terminates TLS and speaks plain HTTP to us, so the scheme the
      // browser used is not the scheme anything here sees. Hosts are what match.
      expect(
        isClaimOriginAllowed("https://paco.2sc.dev", "http://paco.2sc.dev"),
      ).toBe(true);
    });

    test("rejects a different domain", () => {
      expect(
        isClaimOriginAllowed("https://evil.example", "https://paco.2sc.dev"),
      ).toBe(false);
    });

    test("rejects a host that merely extends the configured one", () => {
      expect(
        isClaimOriginAllowed(
          "https://paco.2sc.dev.evil.example",
          "https://paco.2sc.dev",
        ),
      ).toBe(false);
    });

    test("rejects a missing Origin", () => {
      // With something to compare against, an unverifiable request is refused.
      expect(isClaimOriginAllowed(null, "https://paco.2sc.dev")).toBe(false);
    });

    test("rejects an unparseable Origin", () => {
      expect(isClaimOriginAllowed("null", "https://paco.2sc.dev")).toBe(false);
    });

    test("falls open if the configured domain is itself unparseable", () => {
      // It cannot get here — the settings schema rejects it — but locking the
      // owner out of their own instance is the worse of the two failures.
      expect(isClaimOriginAllowed("https://paco.2sc.dev", "not a url")).toBe(
        true,
      );
    });
  });
});
