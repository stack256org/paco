import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HOOK_SOURCE, installHookAt } from "./approval";

/**
 * `buildApprovalSettings` writes the `PreToolUse` hook to a fixed host path
 * (`~/.paco/hooks/pre-tool-use.mjs`) on every call, via `installHookAt`.
 * Concurrent turns — separate chats, separate workflows — call
 * `runAgentTurn`, and therefore this, at the same time: a hook process
 * spawned mid-write by one turn could read a torn file written by another
 * and fail the tool call it was supposed to gate.
 *
 * Exercised directly against a throwaway path rather than through
 * `buildApprovalSettings()`/`hookPath()`: `os.homedir()` cannot be relied on
 * to honor `process.env.HOME` on every runtime this ships on (confirmed:
 * Bun's `homedir()` reads the OS user database, not the environment), so
 * there is no reliable way to redirect the real hook path in a test.
 */
describe("installHookAt", () => {
  let tempDir: string;
  let target: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "paco-approval-hook-"));
    target = join(tempDir, "pre-tool-use.mjs");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("writes the hook, executable, when none exists yet", () => {
    installHookAt(target);

    expect(readFileSync(target, "utf-8")).toBe(HOOK_SOURCE);
    // Owner-executable bit set (0o100), regardless of the exact umask.
    expect(statSync(target).mode & 0o100).toBe(0o100);
  });

  test("skips rewriting the file when its content already matches", () => {
    installHookAt(target);
    const inodeAfterFirstCall = statSync(target).ino;

    installHookAt(target);
    const inodeAfterSecondCall = statSync(target).ino;

    // No rename happened: the file is still the same inode, not a fresh one
    // swapped in by the atomic-write path.
    expect(inodeAfterSecondCall).toBe(inodeAfterFirstCall);
    expect(readFileSync(target, "utf-8")).toBe(HOOK_SOURCE);
  });

  test("atomically replaces a stale file", () => {
    installHookAt(target);
    const inodeBeforeRewrite = statSync(target).ino;

    // Simulate a stale copy from an older build, written directly rather
    // than through `installHookAt`.
    writeFileSync(target, "// stale hook content\n", "utf-8");

    installHookAt(target);

    expect(readFileSync(target, "utf-8")).toBe(HOOK_SOURCE);
    // A genuinely new file was swapped in via rename, not edited in place.
    expect(statSync(target).ino).not.toBe(inodeBeforeRewrite);
    expect(statSync(target).mode & 0o100).toBe(0o100);
  });

  test("writes a fresh file when the target does not exist yet", () => {
    installHookAt(target);

    expect(readFileSync(target, "utf-8")).toBe(HOOK_SOURCE);
  });

  test("never leaves a temp file behind, on either branch", () => {
    installHookAt(target);
    installHookAt(target);
    writeFileSync(target, "// stale\n", "utf-8");
    installHookAt(target);

    expect(readdirSync(tempDir)).toEqual(["pre-tool-use.mjs"]);
  });
});

describe("installHookAt cleanup", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "paco-approval-hook-fail-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("leaves no temp file behind when the install fails", () => {
    // A target inside a directory that does not exist: the write to the
    // sibling temp path fails, which is the failure mode that used to strand
    // a `.pre-tool-use.mjs.<uuid>.tmp` nothing would ever reclaim (each call
    // mints a fresh UUID, so they accumulate).
    const missingDir = join(tempDir, "nope");
    expect(() => installHookAt(join(missingDir, "pre-tool-use.mjs"))).toThrow();
    expect(existsSync(missingDir)).toBe(false);
  });

  test("a failure to install over an existing hook leaves the original intact", () => {
    const target = join(tempDir, "pre-tool-use.mjs");
    writeFileSync(target, "// an older hook\n", "utf-8");

    // Make the containing directory read-only so the temp write fails. Root
    // ignores the mode bits, so skip rather than assert something untrue.
    chmodSync(tempDir, 0o500);
    let threw = false;
    try {
      installHookAt(target);
    } catch {
      threw = true;
    } finally {
      chmodSync(tempDir, 0o700);
    }

    if (!threw) {
      // Running as root (or a filesystem that ignores the mode): the write
      // succeeded, so there is nothing to assert about a failure path.
      expect(readFileSync(target, "utf-8")).toBe(HOOK_SOURCE);
      return;
    }

    // The rename never happened, so the original is untouched...
    expect(readFileSync(target, "utf-8")).toBe("// an older hook\n");
    // ...and no temp file was stranded next to it.
    const strays = readdirSync(tempDir).filter((name) => name.endsWith(".tmp"));
    expect(strays).toEqual([]);
  });
});
