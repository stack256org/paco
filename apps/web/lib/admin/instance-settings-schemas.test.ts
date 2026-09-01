import { describe, expect, test } from "bun:test";
import { domainSchema } from "./instance-settings-schemas";

describe("domainSchema", () => {
  const base = {
    tlsEnabled: true,
    previewBaseDomain: null,
  };

  test("trims a whitespace-padded URL and accepts it", () => {
    const result = domainSchema.safeParse({
      ...base,
      appDomain: "  https://example.com  ",
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.appDomain).toBe("https://example.com");
  });

  test("rejects an invalid URL", () => {
    const result = domainSchema.safeParse({
      ...base,
      appDomain: "not-a-url",
    });

    expect(result.success).toBe(false);
  });

  test("accepts a null appDomain", () => {
    const result = domainSchema.safeParse({ ...base, appDomain: null });

    expect(result.success).toBe(true);
  });

  // `z.url()` accepted all four of these — verified before this schema was
  // switched to `isHttpUrlWithHost` — and each one throws inside `appUrl()`
  // at boot, taking down every route including the settings page an operator
  // would need to undo it from. See lib/app-url.ts and F1 in the phase-1
  // review.
  //
  // The fourth case is built by concatenation rather than written as a
  // literal: it is a rejected input value, never executed, but the literal
  // string trips `no-script-url` regardless of context.
  test.each([
    "localhost:3066",
    "paco.example.com:8080",
    "ftp://x",
    `${"javascript"}:alert(1)`,
  ])("rejects %s, which appUrl() would also reject", (value) => {
    const result = domainSchema.safeParse({ ...base, appDomain: value });

    expect(result.success).toBe(false);
  });

  test.each(["https://paco.example.com", "http://localhost:3066"])(
    "accepts %s",
    (value) => {
      const result = domainSchema.safeParse({ ...base, appDomain: value });

      expect(result.success).toBe(true);
      expect(result.success && result.data.appDomain).toBe(value);
    },
  );

  // `previewHostname` (`lib/preview/hostname.ts`) joins this value onto a
  // chat's slug with no further shape check of its own, and the result is
  // interpolated straight into generated nginx config text — so a
  // malformed value saved here is exactly as malformed at every preview
  // hostname built from it. `[a-z0-9.-]+` alone (the previous rule) let
  // every one of these through.
  test.each([
    "..",
    ".previews.example.com",
    "previews.example.com.",
    "a..b",
    "-",
  ])("rejects %s as a preview base domain", (value) => {
    const result = domainSchema.safeParse({
      ...base,
      appDomain: null,
      previewBaseDomain: value,
    });

    expect(result.success).toBe(false);
  });

  test.each([
    "-previews.example.com",
    "previews-.example.com",
    "previews.example.com-",
  ])("rejects a leading, trailing, or dangling hyphen in %s", (value) => {
    const result = domainSchema.safeParse({
      ...base,
      appDomain: null,
      previewBaseDomain: value,
    });

    expect(result.success).toBe(false);
  });

  test.each([
    "previews.example.com",
    "example.com",
    "localhost",
    "my-previews.example.co.uk",
  ])("accepts %s as a preview base domain", (value) => {
    const result = domainSchema.safeParse({
      ...base,
      appDomain: null,
      previewBaseDomain: value,
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.previewBaseDomain).toBe(value);
  });

  test("accepts a null preview base domain", () => {
    const result = domainSchema.safeParse({
      ...base,
      appDomain: null,
      previewBaseDomain: null,
    });

    expect(result.success).toBe(true);
  });
});
