import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const execCalls: string[] = [];

mock.module("@paco/sandbox", () => ({
  chatBranchName: (chatId: string) => `chat/${chatId}`,
  connectSandbox: async () => ({
    exec: async (command: string) => {
      execCalls.push(command);
      return {
        success: true,
        stdout: /status --porcelain/.test(command)
          ? " M file.ts\n"
          : "abc123\n",
        stderr: "",
      };
    },
  }),
}));

mock.module("@/lib/agent/workspace-paths", () => ({
  hostChatWorktree: () => "/ws/chats/chat1",
}));

mock.module("@/lib/db/sessions", () => ({
  getSessionById: async () => ({
    id: "session-1",
    userId: "user-1",
    repoName: null,
    sandboxState: { type: "docker", sandboxName: "session_1" },
  }),
}));

mock.module("@/lib/db/github-tokens", () => ({
  getGithubToken: async () => null,
}));

mock.module("@/lib/github/gh", () => ({
  GhError: class StubGhError extends Error {
    name = "StubGhError";
  },
  git: async () => ({ stdout: "", stderr: "" }),
}));

mock.module("@/lib/sandbox/utils", () => ({
  isSandboxActive: () => true,
}));

const { commitChanges } = await import("./commit");

describe("commitChanges", () => {
  test("keeps a multi-line body on its own lines, and inert", async () => {
    // `JSON.stringify` produced a double-quoted argument, so bash ran the
    // backticks and wrote the blank line as the two characters `\` and `n`:
    // every commit body ended up mangled onto the subject line.
    execCalls.length = 0;

    const result = await commitChanges({
      sessionId: "session-1",
      chatId: "chat1",
      commitTitle: "fix: use `printf hi` here",
      commitBody: "Body line one\nBody line two $(printf pwned)",
    });

    expect(result.committed).toBe(true);

    const commit = execCalls.find((command) =>
      command.startsWith("git commit"),
    );
    expect(commit).toBe(
      "git commit -m 'fix: use `printf hi` here\n\nBody line one\nBody line two $(printf pwned)'",
    );

    // What bash makes of it is the only thing that settles the question.
    const proc = Bun.spawn(
      ["bash", "-lc", `printf '%s' ${commit?.slice("git commit -m ".length)}`],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);

    expect(stdout).toBe(
      "fix: use `printf hi` here\n\nBody line one\nBody line two $(printf pwned)",
    );
    expect(stdout.split("\n")).toHaveLength(4);
  });
});
