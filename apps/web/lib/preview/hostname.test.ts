import { describe, expect, test } from "bun:test";
import { previewHostname, previewSlug, previewSlugFromHost } from "./hostname";

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

describe("previewSlugFromHost", () => {
  test("recovers the slug when the host ends in the base domain", () => {
    expect(
      previewSlugFromHost(
        "abc123.previews.example.com",
        "previews.example.com",
      ),
    ).toBe("abc123");
  });

  test("is null when the host does not end in the configured base domain", () => {
    expect(
      previewSlugFromHost("abc123.attacker.example", "previews.example.com"),
    ).toBeNull();
  });

  test("rejects a host that merely starts with the same slug", () => {
    // A naive `host.split(".")[0]` extraction would happily return
    // "abc123" here too — exactly the bug this function exists to close.
    expect(
      previewSlugFromHost(
        "abc123.attacker.example.previews.example.com.evil.test",
        "previews.example.com",
      ),
    ).toBeNull();
  });

  test("is null with no base domain configured", () => {
    expect(previewSlugFromHost("abc123.previews.example.com", null)).toBeNull();
  });

  test("is null when the host is exactly the base domain, with no slug", () => {
    expect(
      previewSlugFromHost("previews.example.com", "previews.example.com"),
    ).toBeNull();
  });

  test("round-trips with previewHostname", () => {
    const hostname = previewHostname("abc123", "previews.example.com");
    expect(hostname).not.toBeNull();
    expect(
      previewSlugFromHost(hostname as string, "previews.example.com"),
    ).toBe(previewSlug("abc123"));
  });
});
