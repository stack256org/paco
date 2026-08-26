/**
 * Real git, in throwaway repos under a tmp dir — no mocking of `git` itself,
 * since the whole point of this module is what actually happens on disk:
 * worktrees appearing at declared paths, branches existing, a merge landing
 * on the chat's branch.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

/**
 * The real production seam, mocked at the module boundary rather than
 * injected: the bug this guards against was that NOTHING called
 * `syncPreviewRoutes` after candidates appeared on disk, so a test that
 * passed its own fake in would have kept passing while production stayed
 * broken. Mocking the module means the assertions below exercise the
 * default wiring itself.
 */
let syncPreviewRoutesCalls = 0;
let syncPreviewRoutesFails = false;
mock.module("@/lib/preview/nginx-reload", () => ({
  syncPreviewRoutes: async () => {
    syncPreviewRoutesCalls++;
    if (syncPreviewRoutesFails) {
      throw new Error("nginx -t failed");
    }
  },
}));

/**
 * The other half of the same gap: a candidate's dev server outliving its
 * worktree and holding the port the next design turn's candidate needs.
 * Mocked at the module boundary for the same reason as the route sync.
 */
const stoppedDevServerCalls: Array<{
  chatId: string;
  indexes: readonly number[];
}> = [];
mock.module("@/lib/preview/candidate-dev-server", () => ({
  stopCandidateDevServersForChat: async (params: {
    chatId: string;
    indexes?: readonly (1 | 2 | 3)[];
  }) => {
    stoppedDevServerCalls.push({
      chatId: params.chatId,
      indexes: params.indexes ?? [1, 2, 3],
    });
  },
}));

const {
  createCandidates,
  removeCandidates,
  acceptCandidate,
  resolveCandidate,
} = await import("./candidates");

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

interface Fixture {
  root: string;
  repo: string;
  chatId: string;
  chatBranch: string;
  chatWorktree: string;
}

let fixtures: Fixture[] = [];

/**
 * A session workspace with a repo on `main` and a chat worktree branched off
 * it with one commit of its own — the shape `createCandidates` and
 * `acceptCandidate` are actually handed in production.
 */
async function makeFixture(chatId: string): Promise<Fixture> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "paco-design-candidates-"),
  );
  const repo = path.join(root, "repo");
  await fs.mkdir(repo, { recursive: true });

  await git(repo, ["init", "-q"]);
  await git(repo, ["checkout", "-q", "-b", "main"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(repo, "README.md"), "hello\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "Initial commit"]);

  const chatBranch = `chat/${chatId}`;
  const chatWorktree = path.join(root, "chats", chatId);
  await git(repo, ["worktree", "add", "-q", "-b", chatBranch, chatWorktree]);
  await fs.writeFile(path.join(chatWorktree, "chat.txt"), "chat work\n");
  await git(chatWorktree, ["add", "."]);
  await git(chatWorktree, ["config", "user.email", "test@example.com"]);
  await git(chatWorktree, ["config", "user.name", "Test"]);
  await git(chatWorktree, ["commit", "-q", "-m", "Chat work"]);

  const fixture = { root, repo, chatId, chatBranch, chatWorktree };
  fixtures.push(fixture);
  return fixture;
}

beforeEach(() => {
  fixtures = [];
  syncPreviewRoutesCalls = 0;
  syncPreviewRoutesFails = false;
  stoppedDevServerCalls.length = 0;
});

afterEach(async () => {
  await Promise.all(
    fixtures.map((fixture) =>
      fs.rm(fixture.root, { recursive: true, force: true }),
    ),
  );
});

describe("createCandidates", () => {
  test("creates a worktree and branch per candidate, branched from the chat's branch", async () => {
    const { root, repo, chatId, chatBranch } = await makeFixture("abc123");

    const candidates = await createCandidates({
      sessionWorkspace: root,
      chatId,
      baseBranch: chatBranch,
      count: 3,
    });

    expect(candidates).toHaveLength(3);

    for (const candidate of candidates) {
      expect(candidate.branch).toBe(`design/${chatId}/${candidate.index}`);
      expect(candidate.worktreeDir).toBe(
        path.join(root, "designs", chatId, String(candidate.index)),
      );
      expect(await exists(candidate.worktreeDir)).toBe(true);

      const head = (
        await git(candidate.worktreeDir, ["symbolic-ref", "--short", "HEAD"])
      ).trim();
      expect(head).toBe(candidate.branch);

      // Branched from the chat's branch, not the repo's default branch.
      expect(await exists(path.join(candidate.worktreeDir, "chat.txt"))).toBe(
        true,
      );

      const branchList = await git(repo, [
        "branch",
        "--list",
        candidate.branch,
      ]);
      expect(branchList.trim()).not.toBe("");
    }
  });

  test("self-heals a stale branch and directory left by an aborted run", async () => {
    const { root, repo, chatId, chatBranch } = await makeFixture("stale1");

    // Simulate an earlier run that got as far as creating the branch and a
    // directory at candidate 1's path, then died before (or without)
    // registering a proper worktree there.
    await git(repo, ["branch", `design/${chatId}/1`, chatBranch]);
    const staleDir = path.join(root, "designs", chatId, "1");
    await fs.mkdir(staleDir, { recursive: true });
    await fs.writeFile(path.join(staleDir, "leftover.txt"), "stale\n");

    const candidates = await createCandidates({
      sessionWorkspace: root,
      chatId,
      baseBranch: chatBranch,
      count: 2,
    });

    expect(candidates).toHaveLength(2);
    const first = candidates[0];
    if (!first) {
      throw new Error("expected at least one candidate");
    }

    expect(await exists(path.join(first.worktreeDir, "leftover.txt"))).toBe(
      false,
    );
    expect(await exists(path.join(first.worktreeDir, "chat.txt"))).toBe(true);
    const head = (
      await git(first.worktreeDir, ["symbolic-ref", "--short", "HEAD"])
    ).trim();
    expect(head).toBe(first.branch);
  });
});

describe("removeCandidates", () => {
  test("is safe when no candidates exist", async () => {
    const { root, chatId } = await makeFixture("none");

    await expect(
      removeCandidates({ sessionWorkspace: root, chatId }),
    ).resolves.toBeUndefined();
  });

  test("removes worktrees and branches, and is idempotent", async () => {
    const { root, repo, chatId } = await makeFixture("cleanup1");
    const candidates = await createCandidates({
      sessionWorkspace: root,
      chatId,
      baseBranch: `chat/${chatId}`,
      count: 2,
    });

    await removeCandidates({ sessionWorkspace: root, chatId });

    for (const candidate of candidates) {
      expect(await exists(candidate.worktreeDir)).toBe(false);
    }
    const branchList = await git(repo, [
      "branch",
      "--list",
      `design/${chatId}/*`,
    ]);
    expect(branchList.trim()).toBe("");

    // Calling again must not throw, and must leave the same clean state.
    await expect(
      removeCandidates({ sessionWorkspace: root, chatId }),
    ).resolves.toBeUndefined();
    const worktreeList = await git(repo, ["worktree", "list", "--porcelain"]);
    expect(worktreeList).not.toContain(path.join("designs", chatId));
  });

  test("tolerates a candidate directory deleted by hand before cleanup", async () => {
    const { root, repo, chatId } = await makeFixture("cleanup2");
    const candidates = await createCandidates({
      sessionWorkspace: root,
      chatId,
      baseBranch: `chat/${chatId}`,
      count: 2,
    });

    const half = candidates[1];
    if (!half) {
      throw new Error("expected two candidates");
    }
    // Simulate a worktree directory that vanished without `git worktree
    // remove` being told (e.g. an interrupted cleanup, or manual deletion).
    await fs.rm(half.worktreeDir, { recursive: true, force: true });

    await expect(
      removeCandidates({ sessionWorkspace: root, chatId }),
    ).resolves.toBeUndefined();

    for (const candidate of candidates) {
      expect(await exists(candidate.worktreeDir)).toBe(false);
    }
    const branchList = await git(repo, [
      "branch",
      "--list",
      `design/${chatId}/*`,
    ]);
    expect(branchList.trim()).toBe("");
  });
});

describe("resolveCandidate", () => {
  test("describes a candidate that exists, matching createCandidates", async () => {
    const { root, chatId } = await makeFixture("resolve1");
    const [first, second] = await createCandidates({
      sessionWorkspace: root,
      chatId,
      baseBranch: `chat/${chatId}`,
      count: 2,
    });

    expect(
      await resolveCandidate({ sessionWorkspace: root, chatId, index: 1 }),
    ).toEqual(first);
    expect(
      await resolveCandidate({ sessionWorkspace: root, chatId, index: 2 }),
    ).toEqual(second);
  });

  test("answers null for a candidate that was never created", async () => {
    const { root, chatId } = await makeFixture("resolve2");
    await createCandidates({
      sessionWorkspace: root,
      chatId,
      baseBranch: `chat/${chatId}`,
      count: 2,
    });

    expect(
      await resolveCandidate({ sessionWorkspace: root, chatId, index: 3 }),
    ).toBeNull();
  });

  test("answers null once the candidates have been removed", async () => {
    const { root, chatId } = await makeFixture("resolve3");
    await createCandidates({
      sessionWorkspace: root,
      chatId,
      baseBranch: `chat/${chatId}`,
      count: 2,
    });
    await removeCandidates({ sessionWorkspace: root, chatId });

    expect(
      await resolveCandidate({ sessionWorkspace: root, chatId, index: 1 }),
    ).toBeNull();
  });
});

describe("acceptCandidate", () => {
  test("merges the candidate's commit onto the chat branch and cleans up", async () => {
    const { root, repo, chatId, chatBranch, chatWorktree } =
      await makeFixture("accept1");
    const candidates = await createCandidates({
      sessionWorkspace: root,
      chatId,
      baseBranch: chatBranch,
      count: 2,
    });
    const winner = candidates[0];
    if (!winner) {
      throw new Error("expected at least one candidate");
    }

    await fs.writeFile(
      path.join(winner.worktreeDir, "feature.txt"),
      "the winning design\n",
    );
    await git(winner.worktreeDir, ["add", "."]);
    await git(winner.worktreeDir, ["config", "user.email", "test@example.com"]);
    await git(winner.worktreeDir, ["config", "user.name", "Test"]);
    await git(winner.worktreeDir, ["commit", "-q", "-m", "Candidate change"]);

    const result = await acceptCandidate({
      sessionWorkspace: root,
      chatId,
      index: winner.index,
      chatBranch,
    });

    expect(result.ok).toBe(true);
    expect(await exists(path.join(chatWorktree, "feature.txt"))).toBe(true);

    const subject = (
      await git(chatWorktree, ["log", "-1", "--format=%s"])
    ).trim();
    expect(subject).toBe(`Adopt design candidate ${winner.index}`);

    // Accepting cleans up every candidate, not just the winner.
    for (const candidate of candidates) {
      expect(await exists(candidate.worktreeDir)).toBe(false);
    }
    const branchList = await git(repo, [
      "branch",
      "--list",
      `design/${chatId}/*`,
    ]);
    expect(branchList.trim()).toBe("");
  });

  test("refuses when the chat worktree is dirty, and says how to fix it", async () => {
    const { root, chatId, chatBranch, chatWorktree } =
      await makeFixture("accept2");
    const candidates = await createCandidates({
      sessionWorkspace: root,
      chatId,
      baseBranch: chatBranch,
      count: 2,
    });
    const winner = candidates[0];
    if (!winner) {
      throw new Error("expected at least one candidate");
    }

    // Uncommitted work in the chat's own worktree.
    await fs.writeFile(
      path.join(chatWorktree, "uncommitted.txt"),
      "not committed\n",
    );

    const result = await acceptCandidate({
      sessionWorkspace: root,
      chatId,
      index: winner.index,
      chatBranch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected acceptCandidate to refuse");
    }
    expect(result.error.toLowerCase()).toContain("uncommitted");
    // Names the remedy, not a host path. Since turns stopped committing, a
    // dirty chat worktree is the normal state, so this refusal is something
    // the person will actually read.
    expect(result.error).toContain("Changes tab");
    expect(result.error).not.toContain(chatWorktree);

    // Refused, so nothing was cleaned up.
    expect(await exists(winner.worktreeDir)).toBe(true);
  });

  test("refuses a merge conflict, aborts cleanly, and leaves candidates for retry", async () => {
    const { root, repo, chatId, chatBranch, chatWorktree } =
      await makeFixture("conflict1");
    const candidates = await createCandidates({
      sessionWorkspace: root,
      chatId,
      baseBranch: chatBranch,
      count: 2,
    });
    const winner = candidates[0];
    if (!winner) {
      throw new Error("expected at least one candidate");
    }

    // The candidate and the chat branch both edit the same line of the same
    // file, so merging one into the other conflicts.
    await fs.writeFile(
      path.join(winner.worktreeDir, "chat.txt"),
      "candidate's edit\n",
    );
    await git(winner.worktreeDir, ["add", "."]);
    await git(winner.worktreeDir, ["config", "user.email", "test@example.com"]);
    await git(winner.worktreeDir, ["config", "user.name", "Test"]);
    await git(winner.worktreeDir, ["commit", "-q", "-m", "Candidate edit"]);

    await fs.writeFile(
      path.join(chatWorktree, "chat.txt"),
      "chat's own edit\n",
    );
    await git(chatWorktree, ["commit", "-qam", "Chat edit"]);

    const result = await acceptCandidate({
      sessionWorkspace: root,
      chatId,
      index: winner.index,
      chatBranch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected acceptCandidate to refuse");
    }
    expect(result.error.toLowerCase()).toContain("conflict");

    // The abort left a clean worktree, still on the chat's branch.
    const status = (await git(chatWorktree, ["status", "--porcelain"])).trim();
    expect(status).toBe("");
    const head = (
      await git(chatWorktree, ["symbolic-ref", "--short", "HEAD"])
    ).trim();
    expect(head).toBe(chatBranch);

    // Not cleaned up: the user needs the candidates to retry or inspect.
    for (const candidate of candidates) {
      expect(await exists(candidate.worktreeDir)).toBe(true);
    }
    const branchList = await git(repo, [
      "branch",
      "--list",
      `design/${chatId}/*`,
    ]);
    expect(branchList.trim()).not.toBe("");
  });
});

/**
 * The regression this whole file's newest assertions exist for.
 *
 * Every piece of candidate previewing shipped — the `-d<n>` hostname, the
 * nginx candidate server block with its inspector `sub_filter`, the
 * forward-auth branch — and none of it ever reached nginx, because
 * `syncPreviewRoutes` had exactly one production call site: cold sandbox
 * provisioning, which by definition runs before any `designs/<chatId>/<n>/`
 * exists. Every candidate iframe 404'd, the inspector was never injected, so
 * no annotation could ever be taken, so Iterate was permanently disabled.
 *
 * nginx's preview config is derived state whose only inputs are "which
 * candidate worktrees exist" and "which candidate ports are published". The
 * first input changes exactly here, so this is where the derivation has to be
 * re-run.
 */
describe("preview route syncing", () => {
  test("creating candidates syncs their preview routes", async () => {
    const { root, chatId, chatBranch } = await makeFixture("sync1");

    await createCandidates({
      sessionWorkspace: root,
      chatId,
      baseBranch: chatBranch,
      count: 3,
    });

    expect(syncPreviewRoutesCalls).toBe(1);
  });

  test("the sync happens after the worktrees are on disk, not before", async () => {
    const { root, chatId, chatBranch } = await makeFixture("sync2");
    const seenAtSyncTime: boolean[] = [];

    mock.module("@/lib/preview/nginx-reload", () => ({
      syncPreviewRoutes: async () => {
        syncPreviewRoutesCalls++;
        seenAtSyncTime.push(
          await exists(path.join(root, "designs", chatId, "2")),
        );
      },
    }));

    await createCandidates({
      sessionWorkspace: root,
      chatId,
      baseBranch: chatBranch,
      count: 2,
    });

    // `collectActivePreviewRoutes` detects a candidate by its worktree
    // directory existing, so a sync fired before `worktree add` would find
    // nothing and write no route — the exact shape of the original bug.
    expect(seenAtSyncTime).toEqual([true]);
  });

  test("removing candidates syncs, so the stale conf pointing at a dead upstream goes away", async () => {
    const { root, chatId, chatBranch } = await makeFixture("sync3");

    await createCandidates({
      sessionWorkspace: root,
      chatId,
      baseBranch: chatBranch,
      count: 2,
    });
    syncPreviewRoutesCalls = 0;

    await removeCandidates({ sessionWorkspace: root, chatId });

    expect(syncPreviewRoutesCalls).toBe(1);
  });

  test("a failing sync never fails candidate creation", async () => {
    const { root, chatId, chatBranch } = await makeFixture("sync4");
    syncPreviewRoutesFails = true;

    const candidates = await createCandidates({
      sessionWorkspace: root,
      chatId,
      baseBranch: chatBranch,
      count: 2,
    });

    expect(candidates).toHaveLength(2);
    expect(await exists(candidates[0].worktreeDir)).toBe(true);
  });

  test("accepting a candidate syncs once the candidates are gone", async () => {
    const { root, chatId, chatBranch, chatWorktree } =
      await makeFixture("sync5");

    const candidates = await createCandidates({
      sessionWorkspace: root,
      chatId,
      baseBranch: chatBranch,
      count: 2,
    });
    await fs.writeFile(
      path.join(candidates[0].worktreeDir, "one.txt"),
      "one\n",
    );
    await git(candidates[0].worktreeDir, ["add", "."]);
    await git(candidates[0].worktreeDir, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "-q",
      "-m",
      "Candidate 1",
    ]);
    syncPreviewRoutesCalls = 0;

    const result = await acceptCandidate({
      sessionWorkspace: root,
      chatId,
      index: 1,
      chatBranch,
    });

    expect(result.ok).toBe(true);
    expect(await exists(path.join(chatWorktree, "one.txt"))).toBe(true);
    // Through `removeCandidates`, which accept ends with — one sync, not two.
    expect(syncPreviewRoutesCalls).toBe(1);
  });
});

/**
 * Nothing ever stopped a candidate's dev server. It is started by the
 * candidate's own agent turn on the strength of a prompt sentence, so Paco
 * never held a pid for it — and `rm -rf`'ing the worktree left the process
 * alive, still holding 5173/4321/8000, for the rest of the container's life.
 * The next design turn's candidate then could not bind its port and showed as
 * unreachable with no error anywhere.
 */
describe("candidate dev server ports", () => {
  test("removing candidates reclaims all three candidate ports first", async () => {
    const { root, chatId, chatBranch } = await makeFixture("ports1");

    await createCandidates({
      sessionWorkspace: root,
      chatId,
      baseBranch: chatBranch,
      count: 2,
    });
    stoppedDevServerCalls.length = 0;

    await removeCandidates({ sessionWorkspace: root, chatId });

    expect(stoppedDevServerCalls).toEqual([{ chatId, indexes: [1, 2, 3] }]);
  });

  test("creating candidates reclaims the ports the new candidates need", async () => {
    const { root, chatId, chatBranch } = await makeFixture("ports2");

    await createCandidates({
      sessionWorkspace: root,
      chatId,
      baseBranch: chatBranch,
      count: 2,
    });

    expect(stoppedDevServerCalls).toEqual([{ chatId, indexes: [1, 2] }]);
  });
});
