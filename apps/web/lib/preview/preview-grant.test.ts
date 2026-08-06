import { beforeAll, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

process.env.APP_SECRET ??= "test-secret-for-preview-grant-0000000000000";

let createPreviewGrantToken: (
  host: string,
) => ReturnType<typeof import("./preview-grant").createPreviewGrantToken>;
let verifyPreviewGrantToken: typeof import("./preview-grant").verifyPreviewGrantToken;

beforeAll(async () => {
  ({ createPreviewGrantToken, verifyPreviewGrantToken } =
    await import("./preview-grant"));
});

const HOST = "abc123.previews.example.com";

describe("preview grant tokens", () => {
  test("a freshly minted token verifies for the host it was minted for", () => {
    const { token } = createPreviewGrantToken(HOST);
    expect(verifyPreviewGrantToken(token, HOST)).toBe(true);
  });

  test("does not verify for a different host", () => {
    const { token } = createPreviewGrantToken(HOST);
    expect(verifyPreviewGrantToken(token, "other.previews.example.com")).toBe(
      false,
    );
  });

  test("rejects a tampered signature", () => {
    const { token } = createPreviewGrantToken(HOST);
    const [host, expiresAt] = token.split("|");
    const tampered = `${host}|${expiresAt}|not-the-real-signature`;
    expect(verifyPreviewGrantToken(tampered, HOST)).toBe(false);
  });

  test("rejects a tampered expiry, even if the rest lines up", () => {
    const { token } = createPreviewGrantToken(HOST);
    const [host, expiresAt, signature] = token.split("|");
    const laterExpiry = `${host}|${Number(expiresAt) + 1_000_000}|${signature}`;
    expect(verifyPreviewGrantToken(laterExpiry, HOST)).toBe(false);
  });

  test("rejects an expired token", () => {
    const { token } = createPreviewGrantToken(HOST);
    const originalNow = Date.now;
    try {
      const [, expiresAt] = token.split("|");
      Date.now = () => Number(expiresAt) + 1;
      expect(verifyPreviewGrantToken(token, HOST)).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });

  test("rejects malformed input", () => {
    expect(verifyPreviewGrantToken("not-even-three-parts", HOST)).toBe(false);
    expect(verifyPreviewGrantToken("", HOST)).toBe(false);
    expect(verifyPreviewGrantToken(null, HOST)).toBe(false);
    expect(verifyPreviewGrantToken(undefined, HOST)).toBe(false);
  });

  test("two tokens minted for the same host still verify independently", () => {
    const first = createPreviewGrantToken(HOST);
    const second = createPreviewGrantToken(HOST);
    expect(verifyPreviewGrantToken(first.token, HOST)).toBe(true);
    expect(verifyPreviewGrantToken(second.token, HOST)).toBe(true);
  });
});
