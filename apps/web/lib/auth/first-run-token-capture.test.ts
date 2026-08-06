import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const { readTokenCapture, tokenCaptureMetadata } =
  await import("./first-run-token-capture");

describe("tokenCaptureMetadata / readTokenCapture", () => {
  test("round-trips a capture function through metadata", () => {
    let captured: string | null = null;
    const metadata = tokenCaptureMetadata((token) => {
      captured = token;
    });

    const capture = readTokenCapture(metadata);
    expect(capture).not.toBeNull();
    capture?.("a-token");
    // Read through a function rather than the bare identifier: TypeScript
    // narrows `captured` to `null` here (its last direct assignment in this
    // scope) and does not widen it back just because a closure — the one
    // passed to `tokenCaptureMetadata` above — ran in between.
    const currentCaptured: () => string | null = () => captured;
    expect(currentCaptured()).toBe("a-token");
  });

  test("returns null for metadata with no capture key at all", () => {
    expect(readTokenCapture({})).toBeNull();
    expect(readTokenCapture(undefined)).toBeNull();
    expect(readTokenCapture(null)).toBeNull();
  });

  test("returns null for a non-function value under the capture key", () => {
    expect(readTokenCapture({ captureToken: "not-a-function" })).toBeNull();
  });

  test("ignores a captureToken inherited from the prototype chain", () => {
    // The scenario `Object.hasOwn` guards against: if a prototype-pollution
    // bug elsewhere ever let an attacker set `Object.prototype.captureToken`,
    // *every* magic-link metadata object — not just first-run's — would
    // inherit it. A plain `metadata[CAPTURE_KEY]` read can't tell that apart
    // from the legitimate own-property case; this proves the fix does.
    const base = { captureToken: () => "polluted" };
    const inherited: unknown = Object.create(base);

    expect(readTokenCapture(inherited)).toBeNull();
  });
});
