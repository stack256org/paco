import { describe, expect, test } from "bun:test";
import { deriveAuthUsername, normalizeAuthUsername } from "./username";

describe("auth username helpers", () => {
  test("normalizes usernames for safe storage", () => {
    expect(normalizeAuthUsername(" Gioacchino Albanese! ")).toBe(
      "gioacchino-albanese",
    );
  });

  test("prefers an explicit username over the email", () => {
    expect(
      deriveAuthUsername({
        username: "gioacchinoalbanese-2373",
        email: "gioacchinoalbanese@icloud.com",
        name: "na-test-paco",
      }),
    ).toBe("gioacchinoalbanese-2373");
  });

  test("ignores OpenID Connect claims, which magic-link sign-in never supplies", () => {
    expect(
      deriveAuthUsername({
        preferred_username: "from-oidc",
        email: "gioacchinoalbanese@icloud.com",
      }),
    ).toBe("gioacchinoalbanese");
  });

  test("falls back to email local part", () => {
    expect(
      deriveAuthUsername({
        email: "gioacchinoalbanese@icloud.com",
        name: "na-test-paco",
      }),
    ).toBe("gioacchinoalbanese");
  });
});
