import { describe, expect, test } from "bun:test";
import {
  isSafeWorkspaceName,
  resolveWorkspacePath,
  UnsafeWorkspaceNameError,
} from "./workspace-name";

const ROOT = "/home/u/.paco/workspaces";

describe("isSafeWorkspaceName", () => {
  test("accepts the names Paco actually creates", () => {
    expect(isSafeWorkspaceName("session_abc123")).toBe(true);
    expect(isSafeWorkspaceName("session_session-1")).toBe(true);
  });

  test("rejects anything with a path separator", () => {
    expect(isSafeWorkspaceName("session_a/b")).toBe(false);
    expect(isSafeWorkspaceName("/etc")).toBe(false);
  });

  test("rejects traversal", () => {
    expect(isSafeWorkspaceName("..")).toBe(false);
    expect(isSafeWorkspaceName("../../Documents")).toBe(false);
    expect(isSafeWorkspaceName(".")).toBe(false);
  });

  test("rejects a leading dot, so no dotfile is ever a target", () => {
    expect(isSafeWorkspaceName(".git")).toBe(false);
    expect(isSafeWorkspaceName(".ssh")).toBe(false);
  });

  test("rejects the empty name", () => {
    expect(isSafeWorkspaceName("")).toBe(false);
  });
});

describe("resolveWorkspacePath", () => {
  test("resolves a direct child of the workspace root", () => {
    expect(resolveWorkspacePath("session_abc", ROOT)).toBe(
      `${ROOT}/session_abc`,
    );
  });

  test("throws rather than escaping the root", () => {
    for (const name of ["..", "../..", "/etc/passwd", "a/../../b", ""]) {
      expect(() => resolveWorkspacePath(name, ROOT)).toThrow(
        UnsafeWorkspaceNameError,
      );
    }
  });

  test("never returns the root itself", () => {
    // Removing the root would take every workspace at once.
    expect(() => resolveWorkspacePath(".", ROOT)).toThrow(
      UnsafeWorkspaceNameError,
    );
  });
});
