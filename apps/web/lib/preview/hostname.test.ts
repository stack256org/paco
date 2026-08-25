import { describe, expect, test } from "bun:test";
import {
  candidatePreviewHostname,
  parsePreviewHostSlug,
  previewHostname,
  previewSlug,
  previewSlugFromHost,
} from "./hostname";

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

describe("candidatePreviewHostname", () => {
  test("appends the candidate suffix to the chat's slug", () => {
    expect(candidatePreviewHostname("abc123", 2, "previews.example.com")).toBe(
      `${previewSlug("abc123")}-d2.previews.example.com`,
    );
  });

  test("differs per candidate index for the same chat", () => {
    const one = candidatePreviewHostname("abc123", 1, "previews.example.com");
    const two = candidatePreviewHostname("abc123", 2, "previews.example.com");
    const three = candidatePreviewHostname("abc123", 3, "previews.example.com");
    expect(new Set([one, two, three]).size).toBe(3);
  });

  test("is null when no base domain is configured", () => {
    expect(candidatePreviewHostname("abc123", 1, null)).toBeNull();
  });

  test("is null when the base domain is blank", () => {
    expect(candidatePreviewHostname("abc123", 1, "   ")).toBeNull();
  });
});

describe("parsePreviewHostSlug", () => {
  test("an ordinary chat slug has no candidate index", () => {
    expect(parsePreviewHostSlug("abc123")).toEqual({
      chatSlug: "abc123",
      candidateIndex: null,
    });
  });

  test("recovers the chat slug and candidate index from a candidate label", () => {
    expect(parsePreviewHostSlug("abc123-d2")).toEqual({
      chatSlug: "abc123",
      candidateIndex: 2,
    });
  });

  test("recognizes every valid candidate index", () => {
    expect(parsePreviewHostSlug("abc-d1").candidateIndex).toBe(1);
    expect(parsePreviewHostSlug("abc-d2").candidateIndex).toBe(2);
    expect(parsePreviewHostSlug("abc-d3").candidateIndex).toBe(3);
  });

  test("an out-of-range suffix is left as part of the chat slug", () => {
    expect(parsePreviewHostSlug("abc-d4")).toEqual({
      chatSlug: "abc-d4",
      candidateIndex: null,
    });
  });

  test("a zero or negative-looking suffix is left as part of the chat slug", () => {
    expect(parsePreviewHostSlug("abc-d0")).toEqual({
      chatSlug: "abc-d0",
      candidateIndex: null,
    });
  });

  test("round-trips with candidatePreviewHostname and previewSlugFromHost", () => {
    const hostname = candidatePreviewHostname(
      "abc123",
      3,
      "previews.example.com",
    );
    expect(hostname).not.toBeNull();
    const label = previewSlugFromHost(
      hostname as string,
      "previews.example.com",
    );
    expect(label).not.toBeNull();
    expect(parsePreviewHostSlug(label as string)).toEqual({
      chatSlug: previewSlug("abc123"),
      candidateIndex: 3,
    });
  });
});
