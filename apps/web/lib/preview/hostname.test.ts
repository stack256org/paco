import { describe, expect, test } from "bun:test";
import { previewHostname, previewSlug } from "./hostname";

describe("previewSlug", () => {
  test("is lowercase and DNS-safe", () => {
    const slug = previewSlug("Zx-WuusQjehkVpQVvoOHt");
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug.startsWith("-")).toBe(false);
    expect(slug.endsWith("-")).toBe(false);
  });

  test("is stable for the same chat", () => {
    expect(previewSlug("abc123")).toBe(previewSlug("abc123"));
  });

  test("differs for different chats", () => {
    expect(previewSlug("abc123")).not.toBe(previewSlug("abc124"));
  });

  test("fits in a DNS label", () => {
    expect(previewSlug("Zx-WuusQjehkVpQVvoOHt").length).toBeLessThanOrEqual(63);
  });
});

describe("previewHostname", () => {
  test("joins the slug to the base domain", () => {
    expect(previewHostname("abc123", "previews.example.com")).toBe(
      `${previewSlug("abc123")}.previews.example.com`,
    );
  });

  test("is null when no base domain is configured", () => {
    expect(previewHostname("abc123", null)).toBeNull();
  });

  test("is null when the base domain is blank", () => {
    expect(previewHostname("abc123", "   ")).toBeNull();
  });
});
