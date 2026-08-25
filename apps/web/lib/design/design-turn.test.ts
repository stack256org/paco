/**
 * `runAgentTurn` and `candidates.ts` are both mocked here — `runDesignTurn`
 * takes its candidate list as plain data (`DesignCandidate[]`) and its turn
 * runner via dependency injection (`runTurn`), the same pattern
 * `runAgentTurn` itself uses for `backend` (see that function's doc): tests
 * inject a fake instead of module-mocking. `commitCandidateIfDirty` is
 * exercised for real, against a throwaway git repo, since faking git here
 * would just be re-describing what the function does rather than testing it.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentCallOptions } from "@/lib/agent/types";
import type { DesignCandidate } from "./candidates";
import type { DesignProgress, RunCandidateTurn } from "./design-turn";

mock.module("server-only", () => ({}));

const {
  commitCandidateIfDirty,
  DESIGN_CANDIDATE_MAX_TURNS,
  DesignTurnAllFailedError,
  FALLBACK_DESIGNER_AGENT,
  runDesignTurn,
} = await import("./design-turn");

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

function baseAgentOptions(): AgentCallOptions {
  return {
    sandbox: {
      state: { type: "docker", sandboxName: "test", expiresAt: 0 } as never,
      workingDirectory: "/workspace",
      hostWorkingDirectory: "/workspace",
      currentBranch: "chat/chat-1",
    },
  };
}

function candidate(index: 1 | 2 | 3, worktreeDir: string): DesignCandidate {
  return {
    index,
    branch: `design/chat-1/${index}`,
    worktreeDir,
  };
}

function collectingProgress(): {
  events: DesignProgress[];
  onProgress: (progress: DesignProgress) => Promise<void>;
} {
  const events: DesignProgress[] = [];
  return {
    events,
    onProgress: (progress) => {
      events.push(progress);
      return Promise.resolve();
    },
  };
}

const noopCommit = () => Promise.resolve({ committed: false });

describe("runDesignTurn", () => {
  test("fans out one turn per candidate, in parallel", async () => {
    const candidates = [
      candidate(1, "/designs/1"),
      candidate(2, "/designs/2"),
      candidate(3, "/designs/3"),
    ];
    const calls: Array<{ cwd?: string; maxTurns: number }> = [];
    const runTurn: RunCandidateTurn = (params) => {
      calls.push({
        cwd: params.options.sandbox.hostWorkingDirectory,
        maxTurns: params.maxTurns,
      });
      return Promise.resolve({ isError: false, finishReason: "stop" });
    };
    const { onProgress } = collectingProgress();

    const result = await runDesignTurn({
      candidates,
      prompt: "Build a landing page",
      agentOptions: baseAgentOptions(),
      designerAgent: FALLBACK_DESIGNER_AGENT,
      onProgress,
      onChunk: () => Promise.resolve(),
      runTurn,
      commitCandidate: noopCommit,
    });

    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.cwd).sort()).toEqual([
      "/designs/1",
      "/designs/2",
      "/designs/3",
    ]);
    for (const call of calls) {
      expect(call.maxTurns).toBe(DESIGN_CANDIDATE_MAX_TURNS);
    }
    expect(
      result.outcomes.every((outcome) => outcome.status === "completed"),
    ).toBe(true);
  });

  test("frames each candidate's system prompt with its own direction", async () => {
    const candidates = [candidate(1, "/d/1"), candidate(2, "/d/2")];
    const seenInstructions: string[] = [];
    const runTurn: RunCandidateTurn = (params) => {
      seenInstructions.push(params.options.customInstructions ?? "");
      return Promise.resolve({ isError: false, finishReason: "stop" });
    };

    await runDesignTurn({
      candidates,
      prompt: "Build a landing page",
      agentOptions: baseAgentOptions(),
      designerAgent: FALLBACK_DESIGNER_AGENT,
      onProgress: () => Promise.resolve(),
      onChunk: () => Promise.resolve(),
      runTurn,
      commitCandidate: noopCommit,
    });

    expect(seenInstructions[0]).toContain("DESIGN CANDIDATE 1 of 2");
    expect(seenInstructions[0]).toContain(
      "closest to the existing design language",
    );
    expect(seenInstructions[1]).toContain("DESIGN CANDIDATE 2 of 2");
    expect(seenInstructions[1]).toContain("bolder restructure");
    // The preview-port contract (candidateContainerPort's doc) reaches every
    // candidate's own prompt.
    expect(seenInstructions[0]).toContain("PORT=5173");
    expect(seenInstructions[1]).toContain("PORT=4321");
    // The designer persona itself is included, so the turn behaves as the
    // designer roster agent rather than the default orchestrator.
    expect(seenInstructions[0]).toContain(FALLBACK_DESIGNER_AGENT.prompt);
  });

  test("one candidate failing does not stop the others from succeeding", async () => {
    const candidates = [
      candidate(1, "/d/1"),
      candidate(2, "/d/2"),
      candidate(3, "/d/3"),
    ];
    const runTurn: RunCandidateTurn = (params) => {
      if (params.options.sandbox.hostWorkingDirectory === "/d/2") {
        return Promise.reject(new Error("candidate 2 crashed"));
      }
      return Promise.resolve({ isError: false, finishReason: "stop" });
    };
    const { events, onProgress } = collectingProgress();

    const result = await runDesignTurn({
      candidates,
      prompt: "Build a landing page",
      agentOptions: baseAgentOptions(),
      designerAgent: FALLBACK_DESIGNER_AGENT,
      onProgress,
      onChunk: () => Promise.resolve(),
      runTurn,
      commitCandidate: noopCommit,
    });

    const byIndex = new Map(result.outcomes.map((o) => [o.index, o]));
    expect(byIndex.get(1)?.status).toBe("completed");
    expect(byIndex.get(2)?.status).toBe("failed");
    expect(byIndex.get(2)?.error).toContain("candidate 2 crashed");
    expect(byIndex.get(3)?.status).toBe("completed");

    const failedEvents = events.filter(
      (event) => event.candidate === 2 && event.status === "failed",
    );
    expect(failedEvents).toHaveLength(1);
  });

  test("every candidate failing throws DesignTurnAllFailedError", async () => {
    const candidates = [candidate(1, "/d/1"), candidate(2, "/d/2")];
    const runTurn: RunCandidateTurn = () =>
      Promise.resolve({ isError: true, finishReason: "error" });

    await expect(
      runDesignTurn({
        candidates,
        prompt: "Build a landing page",
        agentOptions: baseAgentOptions(),
        designerAgent: FALLBACK_DESIGNER_AGENT,
        onProgress: () => Promise.resolve(),
        onChunk: () => Promise.resolve(),
        runTurn,
        commitCandidate: noopCommit,
      }),
    ).rejects.toBeInstanceOf(DesignTurnAllFailedError);
  });

  test("all-failed error carries every candidate's outcome", async () => {
    const candidates = [candidate(1, "/d/1"), candidate(2, "/d/2")];
    const runTurn: RunCandidateTurn = () =>
      Promise.resolve({ isError: true, finishReason: "error" });

    try {
      await runDesignTurn({
        candidates,
        prompt: "Build a landing page",
        agentOptions: baseAgentOptions(),
        designerAgent: FALLBACK_DESIGNER_AGENT,
        onProgress: () => Promise.resolve(),
        onChunk: () => Promise.resolve(),
        runTurn,
        commitCandidate: noopCommit,
      });
      throw new Error("expected runDesignTurn to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DesignTurnAllFailedError);
      const allFailed = error as InstanceType<typeof DesignTurnAllFailedError>;
      expect(allFailed.outcomes).toHaveLength(2);
      expect(allFailed.outcomes.every((o) => o.status === "failed")).toBe(true);
    }
  });

  test("commits a dirty candidate worktree after a successful turn", async () => {
    const commitCalls: Array<{ worktreeDir: string; index: number }> = [];
    const commitCandidate = (worktreeDir: string, index: number) => {
      commitCalls.push({ worktreeDir, index });
      return Promise.resolve({ committed: true });
    };
    const runTurn: RunCandidateTurn = () =>
      Promise.resolve({ isError: false, finishReason: "stop" });

    const result = await runDesignTurn({
      candidates: [candidate(1, "/d/1")],
      prompt: "Build a landing page",
      agentOptions: baseAgentOptions(),
      designerAgent: FALLBACK_DESIGNER_AGENT,
      onProgress: () => Promise.resolve(),
      onChunk: () => Promise.resolve(),
      runTurn,
      commitCandidate,
    });

    expect(commitCalls).toEqual([{ worktreeDir: "/d/1", index: 1 }]);
    expect(result.outcomes[0]?.committed).toBe(true);
  });

  test("streams progress in order: running, committing, then a final state", async () => {
    const { events, onProgress } = collectingProgress();
    const runTurn: RunCandidateTurn = () =>
      Promise.resolve({ isError: false, finishReason: "stop" });

    await runDesignTurn({
      candidates: [candidate(1, "/d/1")],
      prompt: "Build a landing page",
      agentOptions: baseAgentOptions(),
      designerAgent: FALLBACK_DESIGNER_AGENT,
      onProgress,
      onChunk: () => Promise.resolve(),
      runTurn,
      commitCandidate: () => Promise.resolve({ committed: true }),
    });

    expect(events.map((event) => event.status)).toEqual([
      "running",
      "committing",
      "completed",
    ]);
    for (const event of events) {
      expect(event.candidate).toBe(1);
    }
  });
});

describe("commitCandidateIfDirty", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "design-turn-commit-"));
    await git(tmpRoot, ["init", "-q"]);
    await git(tmpRoot, ["config", "user.email", "test@example.com"]);
    await git(tmpRoot, ["config", "user.name", "Test"]);
    await fs.writeFile(path.join(tmpRoot, "README.md"), "hello\n");
    await git(tmpRoot, ["add", "-A"]);
    await git(tmpRoot, ["commit", "-q", "-m", "initial"]);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  test("commits when the worktree is dirty", async () => {
    await fs.writeFile(path.join(tmpRoot, "index.html"), "<h1>hi</h1>");

    const result = await commitCandidateIfDirty(tmpRoot, 1);

    expect(result.committed).toBe(true);
    expect(result.error).toBeUndefined();

    const log = await git(tmpRoot, ["log", "-1", "--pretty=%s"]);
    expect(log).toBe("Design candidate 1");

    const status = await git(tmpRoot, ["status", "--porcelain"]);
    expect(status).toBe("");
  });

  test("does nothing when the worktree is clean", async () => {
    const before = await git(tmpRoot, ["rev-parse", "HEAD"]);

    const result = await commitCandidateIfDirty(tmpRoot, 2);

    expect(result.committed).toBe(false);
    expect(result.error).toBeUndefined();

    const after = await git(tmpRoot, ["rev-parse", "HEAD"]);
    expect(after).toBe(before);
  });

  test("reports an error rather than throwing when the directory isn't a git repo", async () => {
    const notARepo = await fs.mkdtemp(
      path.join(os.tmpdir(), "design-turn-not-a-repo-"),
    );
    try {
      const result = await commitCandidateIfDirty(notARepo, 3);
      expect(result.committed).toBe(false);
      expect(result.error).toBeDefined();
    } finally {
      await fs.rm(notARepo, { recursive: true, force: true });
    }
  });
});
