import { describe, expect, test } from "bun:test";
import { buildChatEnvironmentDetails } from "./chat-environment";

const SANDBOX_DETAILS = [
  "- Sandbox: Docker container `paco-sbx-session_abc`",
  "- Your working directory (you run here): /home/u/.paco/workspaces/session_abc",
  "- The same files inside the container: /workspace (only commands you run *in* the container see this path)",
  "",
  "- Dev server URLs (start a server on one of these ports inside the sandbox, then share the URL with the user):",
  "  - Port 3000: http://localhost:55111",
].join("\n");

function build(overrides?: { sandboxDetails?: string }) {
  return buildChatEnvironmentDetails({
    sandboxDetails: SANDBOX_DETAILS,
    worktreePath: "/home/u/.paco/workspaces/session_abc/chats/chat1",
    branch: "chat/chat1",
    ...overrides,
  });
}

describe("buildChatEnvironmentDetails", () => {
  test("names the chat's worktree as the working directory", () => {
    // The agent runs on the host, so this path decides which branch its edits
    // land on. Naming the session repository here would silently put every
    // chat's work on one branch.
    expect(build()).toContain(
      "- Your working directory (you run here): /home/u/.paco/workspaces/session_abc/chats/chat1",
    );
  });

  test("drops the session-level working directory lines", () => {
    const prompt = build();

    // Two "working directory" lines would contradict each other, and the
    // agent picked the first one it saw.
    expect(prompt).not.toContain("workspaces/session_abc\n");
    expect(
      prompt
        .split("\n")
        .filter((l) => l.startsWith("- Your working directory")),
    ).toHaveLength(1);
    expect(
      prompt
        .split("\n")
        .filter((l) => l.startsWith("- The same files inside the container")),
    ).toHaveLength(0);
  });

  test("keeps the container name and the preview URLs", () => {
    const prompt = build();

    expect(prompt).toContain("paco-sbx-session_abc");
    expect(prompt).toContain("http://localhost:55111");
  });

  test("states the branch and why the chat is isolated", () => {
    const prompt = build();

    expect(prompt).toContain("`chat/chat1`");
    expect(prompt).toContain("do not touch other chats");
  });

  test("works when the sandbox supplied no details", () => {
    const prompt = build({ sandboxDetails: undefined });

    expect(prompt).toContain(
      "/home/u/.paco/workspaces/session_abc/chats/chat1",
    );
    expect(prompt.startsWith("\n")).toBe(false);
  });
});
