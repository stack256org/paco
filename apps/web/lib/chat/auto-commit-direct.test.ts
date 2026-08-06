import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

type Exec = { success: boolean; stdout: string; stderr: string };

let execReplies: Array<[RegExp, Partial<Exec>]> = [];
const execCalls: Array<{ command: string; cwd: string }> = [];
const pushCalls: Array<{ args: string[]; cwd?: string }> = [];
let pushError: Error | null = null;
let storedToken: string | null = "ghp_test";

mock.module("@paco/sandbox", () => ({
  chatBranchName: (chatId: string) => `chat/${chatId}`,
}));

mock.module("@/lib/db/github-tokens", () => ({
  getGithubToken: async () => storedToken,
}));

mock.module("@/lib/github/gh", () => ({
  GhError: class StubGhError extends Error {
    name = "StubGhError";
  },
  git: async (args: string[], options: { cwd?: string }) => {
    pushCalls.push({ args, cwd: options.cwd });
    if (pushError) throw pushError;
    return { stdout: "", stderr: "" };
  },
}));

let generatedCommitMessage = "Add a thing";

mock.module("@/lib/github/commit-message", () => ({
  generateCommitMessage: async () => generatedCommitMessage,
}));

const { performAutoCommit, buildFallbackCommitMessage } =
  await import("./auto-commit-direct");

const sandbox = {
  exec: async (command: string, cwd: string) => {
    execCalls.push({ command, cwd });
    const match = execReplies.find(([pattern]) => pattern.test(command));
    return {
      success: match?.[1].success ?? true,
      stdout: match?.[1].stdout ?? "",
      stderr: match?.[1].stderr ?? "",
    };
  },
} as never;

const PARAMS = {
  sandbox,
  userId: "user-1",
  sessionId: "session-1",
  chatId: "chat1",
  sessionTitle: "Add a thing",
  push: true,
  repoOwner: "octocat",
  repoName: "demo",
  cwd: "/ws/chats/chat1",
};

/** A session that was never connected to GitHub: commit only, no remote. */
const LOCAL_ONLY_PARAMS = {
  sandbox,
  userId: "user-1",
  sessionId: "session-1",
  chatId: "chat1",
  sessionTitle: "Add a thing",
  push: false,
  cwd: "/ws/chats/chat1",
};

describe("performAutoCommit", () => {
  beforeEach(() => {
    execCalls.length = 0;
    pushCalls.length = 0;
    pushError = null;
    storedToken = "ghp_test";
    generatedCommitMessage = "Add a thing";
    execReplies = [
      [/status --porcelain/, { stdout: " M file.ts\n" }],
      [/rev-parse HEAD/, { stdout: "abc123\n" }],
    ];
  });

  test("commits the worktree and pushes the chat's branch", async () => {
    const result = await performAutoCommit(PARAMS);

    expect(result).toMatchObject({
      committed: true,
      pushed: true,
      commitMessage: "Add a thing",
      commitSha: "abc123",
    });
    // Every git command runs in the chat's worktree, not the session repo.
    expect(execCalls.every((call) => call.cwd === "/ws/chats/chat1")).toBe(
      true,
    );
    expect(pushCalls[0]?.args).toEqual([
      "push",
      "--set-upstream",
      "origin",
      "chat/chat1",
    ]);
  });

  test("does nothing when the worktree is clean", async () => {
    // The ordinary outcome of a turn that only answered a question.
    execReplies = [[/status --porcelain/, { stdout: "" }]];

    const result = await performAutoCommit(PARAMS);

    expect(result).toEqual({ committed: false, pushed: false });
    expect(pushCalls).toHaveLength(0);
  });

  test("writes the message from the staged diff, after staging", async () => {
    // Reading the diff before `git add` would describe nothing.
    await performAutoCommit(PARAMS);

    const addIndex = execCalls.findIndex((c) => /git add -A/.test(c.command));
    const diffIndex = execCalls.findIndex((c) =>
      /diff --cached/.test(c.command),
    );
    const commitIndex = execCalls.findIndex((c) =>
      /git commit/.test(c.command),
    );

    expect(addIndex).toBeGreaterThanOrEqual(0);
    expect(diffIndex).toBeGreaterThan(addIndex);
    expect(commitIndex).toBeGreaterThan(diffIndex);
  });

  test("quotes the commit message so bash cannot run it", async () => {
    // This message is written by the model and committed with nobody reading
    // it, and `sandbox.exec` runs `bash -lc`. With `JSON.stringify` the
    // backticks were executed — the commit landed as "fix: use hi here" — and
    // the body was flattened onto the subject line with a literal `\n`.
    generatedCommitMessage =
      "fix: use `printf hi` here\n\nBody $(printf pwned); rm -rf /";

    await performAutoCommit(PARAMS);

    const commit = execCalls.find((call) =>
      call.command.startsWith("git commit"),
    );
    expect(commit?.command).toBe(
      `git commit -m 'fix: use \`printf hi\` here\n\nBody $(printf pwned); rm -rf /'`,
    );

    // Running it for real is the only proof that bash treats it as one word.
    const proc = Bun.spawn(
      [
        "bash",
        "-lc",
        `printf '%s' ${commit?.command.slice("git commit -m ".length)}`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(stdout).toBe(generatedCommitMessage);
  });

  test("reports a failed stage without committing", async () => {
    execReplies = [
      [/status --porcelain/, { stdout: " M file.ts\n" }],
      [/git add -A/, { success: false, stderr: "permission denied" }],
    ];

    const result = await performAutoCommit(PARAMS);

    expect(result.committed).toBe(false);
    // The dialog shows this string, so git's own words must not reach it.
    expect(result.error).not.toContain("permission denied");
    expect(result.error).toContain("commit them yourself");
  });

  test("keeps the local commit when there is no token to push with", async () => {
    // Losing the commit because GitHub is not connected would throw away work.
    storedToken = null;

    const result = await performAutoCommit(PARAMS);

    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.error).toContain("Connect your GitHub account");
  });

  test("keeps the local commit when the push fails", async () => {
    pushError = new Error("rejected: non-fast-forward");

    const result = await performAutoCommit(PARAMS);

    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.commitSha).toBe("abc123");
    // The commit is the point of the feature; the push is a bonus that failed.
    expect(result.commitMessage).toBe("Add a thing");
  });

  test("commits without pushing when only local saving is on", async () => {
    const result = await performAutoCommit({ ...PARAMS, push: false });

    expect(result).toMatchObject({
      committed: true,
      pushed: false,
      commitSha: "abc123",
    });
    // Nothing left this machine, so nothing failed and there is no error.
    expect(result.error).toBeUndefined();
    expect(pushCalls).toHaveLength(0);
  });

  test("commits a session that has no GitHub repository at all", async () => {
    // The common case now: a local session, never connected to GitHub. It used
    // to skip saving entirely, which lost the turn's work.
    storedToken = null;

    const result = await performAutoCommit(LOCAL_ONLY_PARAMS);

    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.error).toBeUndefined();
    expect(pushCalls).toHaveLength(0);
  });

  test("does nothing when the worktree is clean and pushing is off", async () => {
    execReplies = [[/status --porcelain/, { stdout: "" }]];

    const result = await performAutoCommit(LOCAL_ONLY_PARAMS);

    expect(result).toEqual({ committed: false, pushed: false });
    expect(
      execCalls.some((call) => call.command.startsWith("git commit")),
    ).toBe(false);
  });

  test("names the changed files when no message could be generated", async () => {
    // "chore: update" is what this used to commit, which tells the owner
    // nothing about which point in the history they are looking at.
    generatedCommitMessage = "   ";
    execReplies = [
      [/status --porcelain/, { stdout: " M app/page.tsx\n?? lib/new.ts\n" }],
      [/rev-parse HEAD/, { stdout: "abc123\n" }],
    ];

    const result = await performAutoCommit(PARAMS);

    expect(result.commitMessage).toBe("Update app/page.tsx, lib/new.ts");
  });
});

describe("buildFallbackCommitMessage", () => {
  test("stops naming files once the subject would get unreadable", () => {
    const status = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]
      .map((path) => ` M ${path}`)
      .join("\n");

    expect(buildFallbackCommitMessage(status, "Session")).toBe(
      "Update a.ts, b.ts, c.ts and 2 more",
    );
  });

  test("names the destination of a rename, not the source", () => {
    expect(
      buildFallbackCommitMessage("R  old/name.ts -> new/name.ts", "Session"),
    ).toBe("Update new/name.ts");
  });

  test("falls back to the session title when no path is readable", () => {
    expect(buildFallbackCommitMessage("", "Fix the login page")).toBe(
      "Save work from Fix the login page",
    );
  });
});
