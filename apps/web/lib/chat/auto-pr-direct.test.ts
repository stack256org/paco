import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

let execReplies: Array<[RegExp, { success?: boolean; stdout?: string }]> = [];
const pushCalls: Array<string[]> = [];
let pushError: Error | null = null;
let storedToken: string | null = "ghp_test";
let existingPr: { number: number; url: string; state: string } | null = null;
let createResult: { number: number; url: string; state: string } | Error = {
  number: 12,
  url: "https://github.com/o/r/pull/12",
  state: "open",
};
const createCalls: Array<Record<string, unknown>> = [];
const sessionUpdates: Array<Record<string, unknown>> = [];

mock.module("@paco/sandbox", () => ({
  chatBranchName: (chatId: string) => `chat/${chatId}`,
}));

mock.module("@/lib/db/github-tokens", () => ({
  getGithubToken: async () => storedToken,
}));

mock.module("@/lib/db/sessions", () => ({
  updateSession: async (_id: string, values: Record<string, unknown>) => {
    sessionUpdates.push(values);
  },
}));

mock.module("@/lib/github/gh", () => ({
  GhError: class StubGhError extends Error {
    name = "StubGhError";
  },
  git: async (args: string[]) => {
    pushCalls.push(args);
    if (pushError) throw pushError;
    return { stdout: "", stderr: "" };
  },
}));

mock.module("@/lib/github/gh-pr", () => ({
  findPullRequest: async () => existingPr,
  createPullRequest: async (params: Record<string, unknown>) => {
    createCalls.push(params);
    if (createResult instanceof Error) throw createResult;
    return createResult;
  },
}));

mock.module("@/lib/github/pr-content", () => ({
  generatePullRequestContentFromSandbox: async () => ({
    success: true,
    title: "Add auth",
    body: "Does the thing",
  }),
}));

const { performAutoCreatePr } = await import("./auto-pr-direct");

const sandbox = {
  exec: async (command: string) => {
    const match = execReplies.find(([pattern]) => pattern.test(command));
    return {
      success: match?.[1].success ?? true,
      stdout: match?.[1].stdout ?? "",
      stderr: "",
    };
  },
} as never;

const PARAMS = {
  sandbox,
  userId: "user-1",
  sessionId: "session-1",
  chatId: "chat1",
  sessionTitle: "Add auth",
  repoOwner: "octocat",
  repoName: "demo",
  baseBranch: "main",
  cwd: "/ws/chats/chat1",
};

describe("performAutoCreatePr", () => {
  beforeEach(() => {
    pushCalls.length = 0;
    createCalls.length = 0;
    sessionUpdates.length = 0;
    pushError = null;
    storedToken = "ghp_test";
    existingPr = null;
    createResult = {
      number: 12,
      url: "https://github.com/o/r/pull/12",
      state: "open",
    };
    execReplies = [[/rev-list --count/, { stdout: "3\n" }]];
  });

  test("pushes the chat's branch and opens a pull request", async () => {
    const result = await performAutoCreatePr(PARAMS);

    expect(pushCalls[0]).toEqual([
      "push",
      "--set-upstream",
      "origin",
      "chat/chat1",
    ]);
    expect(createCalls[0]).toMatchObject({
      base: "main",
      head: "chat/chat1",
      title: "Add auth",
    });
    expect(result).toMatchObject({ created: true, prNumber: 12 });
    expect(sessionUpdates[0]).toEqual({ prNumber: 12, prStatus: "open" });
  });

  test("skips when the branch is no commits ahead", async () => {
    // The ordinary case now that turns do not commit: the work is sitting
    // uncommitted in the worktree, waiting for the operator to choose it.
    execReplies = [[/rev-list --count/, { stdout: "0\n" }]];

    const result = await performAutoCreatePr(PARAMS);

    expect(result).toMatchObject({ skipped: true });
    expect(result.skipReason).toBe(
      "Nothing committed yet — commit to open a pull request",
    );
    // Short enough to survive the truncated one-line label it is shown in.
    expect(result.skipReason?.length).toBeLessThanOrEqual(60);
    expect(pushCalls).toHaveLength(0);
    expect(createCalls).toHaveLength(0);
  });

  test("skips rather than guessing when the base cannot be compared", async () => {
    // The count only fails when `origin/<base>` is missing, and a base branch
    // GitHub has never seen cannot be a pull request's target. This used to
    // fall through and open the pull request anyway.
    execReplies = [[/rev-list --count/, { success: false }]];

    const result = await performAutoCreatePr(PARAMS);

    expect(result).toMatchObject({ skipped: true, created: false });
    expect(pushCalls).toHaveLength(0);
    expect(createCalls).toHaveLength(0);
  });

  test("skips when GitHub is not connected", async () => {
    storedToken = null;

    const result = await performAutoCreatePr(PARAMS);

    expect(result).toMatchObject({ skipped: true });
    expect(result.skipReason).toContain("not connected");
  });

  test("updates an existing pull request by pushing, not by making another", async () => {
    existingPr = {
      number: 5,
      url: "https://github.com/o/r/pull/5",
      state: "open",
    };

    const result = await performAutoCreatePr(PARAMS);

    expect(pushCalls).toHaveLength(1);
    expect(createCalls).toHaveLength(0);
    expect(result).toMatchObject({
      syncedExisting: true,
      created: false,
      prNumber: 5,
    });
  });

  test("opens a new pull request when the old one was closed", async () => {
    existingPr = {
      number: 5,
      url: "https://github.com/o/r/pull/5",
      state: "closed",
    };

    const result = await performAutoCreatePr(PARAMS);

    expect(createCalls).toHaveLength(1);
    expect(result.created).toBe(true);
  });

  test("reports a failed push without claiming a pull request", async () => {
    pushError = new Error("rejected");

    const result = await performAutoCreatePr(PARAMS);

    expect(result.created).toBe(false);
    expect(result.error).toBeDefined();
    expect(createCalls).toHaveLength(0);
    expect(sessionUpdates).toHaveLength(0);
  });
});
