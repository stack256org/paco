import { describe, expect, test } from "bun:test";
import { buildCandidatePreviews } from "./candidate-preview-url";

describe("buildCandidatePreviews", () => {
  test("gives every candidate index its own -d<n> hostname", () => {
    const previews = buildCandidatePreviews({
      chatId: "abc123",
      previewBaseDomain: "previews.example.com",
      tlsEnabled: true,
    });

    expect(previews).toEqual([
      { index: 1, url: "https://abc123-d1.previews.example.com" },
      { index: 2, url: "https://abc123-d2.previews.example.com" },
      { index: 3, url: "https://abc123-d3.previews.example.com" },
    ]);
  });

  test("uses http when previews are not served over TLS", () => {
    const previews = buildCandidatePreviews({
      chatId: "abc123",
      previewBaseDomain: "previews.example.com",
      tlsEnabled: false,
    });

    expect(previews[0].url).toBe("http://abc123-d1.previews.example.com");
  });

  test("has nothing to offer without a preview base domain", () => {
    expect(
      buildCandidatePreviews({
        chatId: "abc123",
        previewBaseDomain: null,
        tlsEnabled: true,
      }),
    ).toEqual([]);
  });

  test("sanitizes a chat id into a DNS-legal label", () => {
    const previews = buildCandidatePreviews({
      chatId: "Abc_123",
      previewBaseDomain: "previews.example.com",
      tlsEnabled: true,
    });

    expect(previews[0].url).toBe("https://abc-123-d1.previews.example.com");
  });
});
