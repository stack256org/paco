import { beforeAll, describe, expect, mock, test } from "bun:test";

// The module under test is server-only; the marker package throws outside a
// server component and has nothing to do with what is being tested.
mock.module("server-only", () => ({}));

process.env.APP_SECRET ??= "test-secret-for-secret-box-000000000000";

let seal: (plaintext: string) => string;
let open: (sealed: string) => string;

beforeAll(async () => {
  ({ seal, open } = await import("./secret-box"));
});

describe("secret-box", () => {
  test("round-trips a secret", () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

    expect(open(seal(token))).toBe(token);
  });

  test("round-trips non-ASCII and empty values", () => {
    expect(open(seal(""))).toBe("");
    expect(open(seal("naïve — 🔐"))).toBe("naïve — 🔐");
  });

  test("never stores the plaintext", () => {
    const token = "ghp_supersecretvalue";

    expect(seal(token)).not.toContain(token);
  });

  test("produces a different ciphertext each time", () => {
    // A fixed IV would make identical tokens identical on disk, which leaks
    // that two users share one.
    const token = "ghp_same";

    expect(seal(token)).not.toBe(seal(token));
  });

  test("rejects a tampered ciphertext rather than returning wrong bytes", () => {
    const sealed = seal("ghp_original");
    const parts = sealed.split(".");
    const body = Buffer.from(parts[3] as string, "base64url");
    body[0] = (body[0] ?? 0) ^ 0xff;
    const tampered = [
      parts[0],
      parts[1],
      parts[2],
      body.toString("base64url"),
    ].join(".");

    expect(() => open(tampered)).toThrow();
  });

  test("rejects a swapped authentication tag", () => {
    const a = seal("ghp_a").split(".");
    const b = seal("ghp_b").split(".");
    const mixed = [a[0], a[1], b[2], a[3]].join(".");

    expect(() => open(mixed)).toThrow();
  });

  test("rejects malformed and unknown-version values", () => {
    expect(() => open("not-sealed")).toThrow(/Malformed/);
    expect(() => open("v1.a.b")).toThrow(/Malformed/);
    expect(() => open(seal("x").replace(/^v1\./, "v2."))).toThrow(
      /Unsupported sealed secret version/,
    );
  });

  test("rejects a truncated initialisation vector", () => {
    const parts = seal("ghp_x").split(".");
    const truncated = [parts[0], "AAAA", parts[2], parts[3]].join(".");

    expect(() => open(truncated)).toThrow(/Malformed/);
  });
});
