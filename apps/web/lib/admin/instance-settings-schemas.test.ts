import { describe, expect, test } from "bun:test";
import {
  domainSchema,
  emailAddressSchema,
  poolsideSchema,
  smtpSchema,
} from "./instance-settings-schemas";

describe("emailAddressSchema", () => {
  test("trims a whitespace-padded email and accepts it", () => {
    const result = emailAddressSchema.safeParse("  admin@example.com  ");

    expect(result.success).toBe(true);
    expect(result.success && result.data).toBe("admin@example.com");
  });

  test("rejects an invalid email", () => {
    const result = emailAddressSchema.safeParse("not-an-email");

    expect(result.success).toBe(false);
  });
});

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

  // `previewSlugFromHost` (`lib/preview/hostname.ts`) matches an incoming
  // preview host against `.${previewBaseDomain}` as a plain string suffix,
  // with no further shape check of its own — so a malformed value saved
  // here is exactly as malformed at every request this suffix check runs
  // against. `[a-z0-9.-]+` alone (the previous rule) let every one of
  // these through.
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

describe("smtpSchema password normalisation", () => {
  const base = {
    host: "smtp.example.com",
    port: 587,
    secure: false,
    user: null,
    from: "Paco <no-reply@example.com>",
  };

  test("normalises an empty string to null", () => {
    const result = smtpSchema.safeParse({ ...base, password: "" });

    expect(result.success).toBe(true);
    expect(result.success && result.data.password).toBeNull();
  });

  test("normalises a whitespace-only string to null", () => {
    const result = smtpSchema.safeParse({ ...base, password: "   " });

    expect(result.success).toBe(true);
    expect(result.success && result.data.password).toBeNull();
  });

  test("leaves null as null", () => {
    const result = smtpSchema.safeParse({ ...base, password: null });

    expect(result.success).toBe(true);
    expect(result.success && result.data.password).toBeNull();
  });

  test("passes a real password through unchanged", () => {
    const result = smtpSchema.safeParse({ ...base, password: "hunter2" });

    expect(result.success).toBe(true);
    expect(result.success && result.data.password).toBe("hunter2");
  });

  test("preserves a password with leading/trailing spaces verbatim", () => {
    const result = smtpSchema.safeParse({ ...base, password: " hunter2 " });

    expect(result.success).toBe(true);
    expect(result.success && result.data.password).toBe(" hunter2 ");
  });
});

describe("poolsideSchema", () => {
  const base = { binaryPath: null, apiKey: null };

  test("trims a whitespace-padded base URL and accepts it", () => {
    const result = poolsideSchema.safeParse({
      ...base,
      baseUrl: "  https://pool.example.com  ",
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.baseUrl).toBe(
      "https://pool.example.com",
    );
  });

  test("normalises a blank base URL to null", () => {
    const result = poolsideSchema.safeParse({ ...base, baseUrl: "   " });

    expect(result.success).toBe(true);
    expect(result.success && result.data.baseUrl).toBeNull();
  });

  test("accepts a null base URL — the default Poolside service", () => {
    const result = poolsideSchema.safeParse({ ...base, baseUrl: null });

    expect(result.success).toBe(true);
  });

  test("rejects an invalid base URL", () => {
    const result = poolsideSchema.safeParse({
      ...base,
      baseUrl: "not-a-url",
    });

    expect(result.success).toBe(false);
  });

  test("a blank apiKey means 'leave the stored one alone'", () => {
    const result = poolsideSchema.safeParse({
      ...base,
      baseUrl: null,
      apiKey: "   ",
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.apiKey).toBeNull();
  });

  test("passes a real apiKey through unchanged", () => {
    const result = poolsideSchema.safeParse({
      ...base,
      baseUrl: null,
      apiKey: "sk-poolside-secret",
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.apiKey).toBe("sk-poolside-secret");
  });

  test("rejects a blank binaryPath (use null to mean unset)", () => {
    const result = poolsideSchema.safeParse({
      baseUrl: null,
      apiKey: null,
      binaryPath: "",
    });

    expect(result.success).toBe(false);
  });

  /**
   * The removed backend's key had its own field name. A form still POSTing
   * `endpoint` must not slip through as a Poolside base URL by accident.
   */
  test("an OpenFX-shaped payload does not validate as Poolside settings", () => {
    const result = poolsideSchema.safeParse({
      endpoint: "https://gateway.example.com",
      apiKey: null,
      binaryPath: null,
    });

    expect(result.success).toBe(false);
  });
});
