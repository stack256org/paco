import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

mock.module("@paco/sandbox", () => ({
  workspaceRoot: () => "/home/u/.paco/workspaces",
  chatWorktreePath: (chatId: string) => `chats/${chatId}`,
  repoDir: (root: string) => `${root}/repo`,
}));

const { hostChatWorktree, hostWorkspaceFor, resolveWorkCwd } =
  await import("./workspace-paths");

const STATE = { sandboxName: "session_abc" } as never;

describe("hostWorkspaceFor", () => {
  test("derives the path from the sandbox name", () => {
    expect(hostWorkspaceFor(STATE)).toBe(
      "/home/u/.paco/workspaces/session_abc",
    );
  });

  test("prefers an explicit host path from an older row", () => {
    // `hostWorkspace` stopped being persisted once it was no longer sent to
    // the browser, but rows written before that still carry it.
    expect(hostWorkspaceFor({ hostWorkspace: "/custom/place" } as never)).toBe(
      "/custom/place",
    );
  });

  test("refuses to guess when the state names nothing", () => {
    expect(() => hostWorkspaceFor({} as never)).toThrow(/cannot locate/);
  });
});

describe("resolveWorkCwd", () => {
  test("uses the chat's worktree when there is a chat", () => {
    expect(resolveWorkCwd(STATE, "chat1")).toBe(
      "/home/u/.paco/workspaces/session_abc/chats/chat1",
    );
    expect(resolveWorkCwd(STATE, "chat1")).toBe(
      hostChatWorktree(STATE, "chat1"),
    );
  });

  test("falls back to the repository for session-wide callers", () => {
    // Not the workspace root: that holds `repo/` and `chats/` side by side and
    // is not itself a git repository, so git commands there simply fail.
    expect(resolveWorkCwd(STATE)).toBe(
      "/home/u/.paco/workspaces/session_abc/repo",
    );
    expect(resolveWorkCwd(STATE, null)).toBe(
      "/home/u/.paco/workspaces/session_abc/repo",
    );
    expect(resolveWorkCwd(STATE, "")).toBe(
      "/home/u/.paco/workspaces/session_abc/repo",
    );
  });
});
