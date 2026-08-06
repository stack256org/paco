import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

type Call = { command: "gh" | "git"; args: string[]; cwd?: string };

const calls: Call[] = [];
let replies: Array<[RegExp, { stdout?: string; fail?: string }]> = [];

function reply(command: "gh" | "git", args: string[]) {
  const joined = args.join(" ");
  const match = replies.find(([pattern]) => pattern.test(joined));
  if (match?.[1].fail !== undefined) {
    throw new GhError(
      `${command} failed: ${match[1].fail}`,
      "failed",
      1,
      match[1].fail,
    );
  }
  return { stdout: match?.[1].stdout ?? "", stderr: "" };
}

/** Mirrors the shape `gh-pr` branches on, without the spawn machinery. */
class StubGhError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "StubGhError";
  }
}

mock.module("./gh", () => ({
  GhError: StubGhError,
  gh: async (args: string[], options: { cwd?: string }) => {
    calls.push({ command: "gh", args, cwd: options.cwd });
    return reply("gh", args);
  },
  git: async (args: string[], options: { cwd?: string }) => {
    calls.push({ command: "git", args, cwd: options.cwd });
    return reply("git", args);
  },
  ghJson: async (args: string[], options: { cwd?: string }) => {
    calls.push({ command: "gh", args, cwd: options.cwd });
    return JSON.parse(reply("gh", args).stdout || "{}");
  },
}));

const { GhError } = await import("./gh");
const {
  closePullRequest,
  createPullRequest,
  findPullRequest,
  mergePullRequest,
} = await import("./gh-pr");

const OPEN_PR = JSON.stringify({
  number: 7,
  url: "https://github.com/o/r/pull/7",
  state: "OPEN",
  title: "Add auth",
  isDraft: false,
  mergedAt: null,
  baseRefName: "main",
  headRefName: "chat/abc",
  statusCheckRollup: [],
});

const BASE = { token: "t", cwd: "/ws/chats/abc" };

describe("createPullRequest", () => {
  beforeEach(() => {
    calls.length = 0;
    replies = [[/pr view/, { stdout: OPEN_PR }]];
  });

  test("pushes the branch before opening the pull request", async () => {
    // `gh pr create` refuses a branch the remote has never seen, and its offer
    // to push is interactive — which is disabled, so it would just fail.
    await createPullRequest({
      ...BASE,
      base: "main",
      head: "chat/abc",
      title: "Add auth",
    });

    expect(calls[0]).toEqual({
      command: "git",
      args: ["push", "--set-upstream", "origin", "chat/abc"],
      cwd: BASE.cwd,
    });
    expect(calls[1]?.args.slice(0, 2)).toEqual(["pr", "create"]);
  });

  test("opens it from the chat's branch, in the chat's worktree", async () => {
    // The whole point: a session-wide branch would collapse every chat's work
    // into one pull request.
    await createPullRequest({
      ...BASE,
      base: "main",
      head: "chat/abc",
      title: "Add auth",
      body: "Body with `backticks` and $(id)",
    });

    const create = calls.find((c) => c.args[1] === "create");
    expect(create?.cwd).toBe("/ws/chats/abc");
    expect(create?.args).toContain("--head");
    expect(create?.args).toContain("chat/abc");
    // Passed as one argument, so shell syntax in a generated body is inert.
    expect(create?.args).toContain("Body with `backticks` and $(id)");
  });

  test("marks a draft only when asked", async () => {
    await createPullRequest({
      ...BASE,
      base: "main",
      head: "chat/abc",
      title: "t",
    });
    expect(calls.find((c) => c.args.includes("--draft"))).toBeUndefined();

    calls.length = 0;
    await createPullRequest({
      ...BASE,
      base: "main",
      head: "chat/abc",
      title: "t",
      draft: true,
    });
    expect(calls.find((c) => c.args.includes("--draft"))).toBeDefined();
  });

  test("reports a rejected push as a push failure", async () => {
    // Not as a confusing pull-request error, which is what a caller would see
    // if the push were left to `gh pr create`.
    replies = [[/^push/, { fail: "rejected: non-fast-forward" }]];

    await expect(
      createPullRequest({
        ...BASE,
        base: "main",
        head: "chat/abc",
        title: "t",
      }),
    ).rejects.toThrow(/non-fast-forward/);
  });
});

describe("findPullRequest", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  test("returns the pull request for a branch", async () => {
    replies = [[/pr view/, { stdout: OPEN_PR }]];

    const pr = await findPullRequest({ ...BASE, branch: "chat/abc" });

    expect(pr?.number).toBe(7);
    expect(pr?.state).toBe("open");
    expect(pr?.headBranch).toBe("chat/abc");
  });

  test("returns null when the branch has no pull request", async () => {
    // An ordinary answer, not a failure — `gh` just exits non-zero for it.
    replies = [
      [/pr view/, { fail: 'no pull requests found for branch "chat/abc"' }],
    ];

    expect(await findPullRequest({ ...BASE, branch: "chat/abc" })).toBeNull();
  });

  test("still raises anything else", async () => {
    replies = [[/pr view/, { fail: "Bad credentials (HTTP 401)" }]];

    await expect(
      findPullRequest({ ...BASE, branch: "chat/abc" }),
    ).rejects.toThrow(/Bad credentials/);
  });
});

describe("check rollup", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  async function checksFor(rollup: unknown) {
    replies = [
      [
        /pr view/,
        {
          stdout: JSON.stringify({
            ...JSON.parse(OPEN_PR),
            statusCheckRollup: rollup,
          }),
        },
      ],
    ];
    const pr = await findPullRequest({ ...BASE, branch: "chat/abc" });
    return pr?.checks;
  }

  test("no checks reads as null, not as passing", async () => {
    expect(await checksFor([])).toBeNull();
    expect(await checksFor(null)).toBeNull();
  });

  test("all successful reads as passing", async () => {
    expect(
      await checksFor([{ conclusion: "SUCCESS" }, { conclusion: "SKIPPED" }]),
    ).toBe("passing");
  });

  test("one failure outweighs any number of passes", async () => {
    expect(
      await checksFor([
        { conclusion: "SUCCESS" },
        { conclusion: "FAILURE" },
        { conclusion: "SUCCESS" },
      ]),
    ).toBe("failing");
  });

  test("a failure outranks a still-running check", async () => {
    // Order matters: reporting "pending" would suggest waiting for an answer
    // that has already arrived.
    expect(
      await checksFor([{ status: "IN_PROGRESS" }, { conclusion: "FAILURE" }]),
    ).toBe("failing");
  });

  test("anything unfinished reads as pending", async () => {
    expect(
      await checksFor([{ conclusion: "SUCCESS" }, { status: "QUEUED" }]),
    ).toBe("pending");
  });

  test("reads legacy commit statuses too", async () => {
    // Check runs report `conclusion`; older commit statuses report `state`.
    expect(await checksFor([{ state: "FAILURE" }])).toBe("failing");
    expect(await checksFor([{ state: "SUCCESS" }])).toBe("passing");
  });
});

describe("mergePullRequest", () => {
  beforeEach(() => {
    calls.length = 0;
    replies = [
      [
        /pr view/,
        {
          stdout: JSON.stringify({
            ...JSON.parse(OPEN_PR),
            state: "MERGED",
            mergedAt: "2026-07-30T12:00:00Z",
          }),
        },
      ],
    ];
  });

  test("uses the requested merge method and reports the new state", async () => {
    const pr = await mergePullRequest({ ...BASE, number: 7, method: "squash" });

    expect(calls[0]?.args).toEqual(["pr", "merge", "7", "--squash"]);
    expect(pr.state).toBe("merged");
    expect(pr.mergedAt).toBe("2026-07-30T12:00:00Z");
  });

  test("deletes the branch only when asked", async () => {
    await mergePullRequest({ ...BASE, number: 7, method: "merge" });
    expect(calls[0]?.args).not.toContain("--delete-branch");

    calls.length = 0;
    await mergePullRequest({
      ...BASE,
      number: 7,
      method: "merge",
      deleteBranch: true,
    });
    expect(calls[0]?.args).toContain("--delete-branch");
  });
});

describe("closePullRequest", () => {
  test("closes it and reports the new state", async () => {
    calls.length = 0;
    replies = [
      [
        /pr view/,
        { stdout: JSON.stringify({ ...JSON.parse(OPEN_PR), state: "CLOSED" }) },
      ],
    ];

    const pr = await closePullRequest({ ...BASE, number: 7 });

    expect(calls[0]?.args).toEqual(["pr", "close", "7"]);
    expect(pr.state).toBe("closed");
  });
});
