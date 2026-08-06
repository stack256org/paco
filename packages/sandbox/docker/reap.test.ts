import { describe, expect, test } from "bun:test";
import {
  isSandboxContainerName,
  normalizeContainerName,
  pickSandboxContainerName,
  removeSandboxContainer,
} from "./reap.ts";

describe("isSandboxContainerName", () => {
  test("accepts a sandbox container", () => {
    expect(isSandboxContainerName("paco-sbx-session_abc")).toBe(true);
  });

  test("rejects the database, which shares the paco prefix", () => {
    // The one that matters. `paco-pg` holds every session, message and token
    // in the product; a prefix match on "paco" would have removed it.
    expect(isSandboxContainerName("paco-pg")).toBe(false);
  });

  test("rejects containers belonging to anything else on the host", () => {
    for (const name of [
      "syngulr-redis",
      "syngulr-chat-pg",
      "debutify-pg",
      "postgres",
      "",
      "paco",
      "sbx-session_abc",
      "my-paco-sbx-session_abc",
    ]) {
      expect(isSandboxContainerName(name)).toBe(false);
    }
  });

  test("rejects the bare prefix with no sandbox name after it", () => {
    expect(isSandboxContainerName("paco-sbx-")).toBe(false);
  });
});

describe("normalizeContainerName", () => {
  test("strips the leading slash Docker reports", () => {
    expect(normalizeContainerName("/paco-sbx-session_abc")).toBe(
      "paco-sbx-session_abc",
    );
  });

  test("leaves an already-bare name alone", () => {
    expect(normalizeContainerName("paco-sbx-session_abc")).toBe(
      "paco-sbx-session_abc",
    );
  });
});

describe("pickSandboxContainerName", () => {
  test("finds the sandbox name among several", () => {
    expect(
      pickSandboxContainerName(["/some-alias", "/paco-sbx-session_abc"]),
    ).toBe("paco-sbx-session_abc");
  });

  test("returns null when none of the names is Paco's", () => {
    expect(pickSandboxContainerName(["/paco-pg", "/debutify-pg"])).toBeNull();
  });

  test("returns null for a container with no names at all", () => {
    expect(pickSandboxContainerName([])).toBeNull();
  });
});

describe("removeSandboxContainer", () => {
  test("refuses a name that is not Paco's before touching Docker", async () => {
    // No Docker call is made, so this passes with the daemon down: the guard is
    // the first statement in the function, deliberately ahead of any I/O.
    await expect(removeSandboxContainer("paco-pg")).rejects.toThrow(
      /not Paco's/,
    );
    await expect(removeSandboxContainer("debutify-pg")).rejects.toThrow(
      /not Paco's/,
    );
    await expect(removeSandboxContainer("")).rejects.toThrow(/not Paco's/);
  });
});
