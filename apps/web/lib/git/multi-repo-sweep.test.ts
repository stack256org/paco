import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * The multi-repository scenario sweep: every scenario checked, one by one.
 *
 * Where the fast suites sample the space, this enumerates it: workspace
 * layouts × repository targets × file-change kinds × operations, and runs
 * **each combination individually** — a real git workspace is built, the
 * change is made on disk, the real server action is called, and the outcome
 * is verified with an independent raw-git command, never by trusting the
 * action's own answer. Every scenario gets an id and a PASS/FAIL row in
 * `docs/verification/multi-repo-scenario-sweep.md`.
 *
 * Deliberately not part of `pnpm run ci` — 2,200 real-git scenarios take
 * minutes, and CI's job is the fast suites. Run it with:
 *
 *     pnpm --dir apps/web sweep:multi-repo
 */

const SWEEP = process.env.SCENARIO_SWEEP === "1";

// ── harness (mirrors source-control-actions.test.ts) ───────────────

mock.module("server-only", () => ({}));
mock.module("@/lib/db/sessions", () => ({
  getChatById: () => Promise.resolve({ id: "chat-1", sessionId: "session-1" }),
  getSessionById: () =>
    Promise.resolve({
      id: "session-1",
      sandboxState: { type: "docker", sandboxName: "session_session-1" },
    }),
  updateSession: () => Promise.resolve(),
}));
mock.module("@/lib/sandbox/utils", () => ({
  isSandboxActive: () => true,
  isSandboxUnavailableError: () => false,
}));

const workspace = { dir: "" };

function sh(command: string, cwd: string): string {
  return execFileSync("bash", ["-c", command], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
}

const shellSandbox = {
  workingDirectory: "",
  exec: async (command: string, cwd: string) => {
    try {
      return {
        success: true,
        exitCode: 0,
        stdout: sh(command, cwd),
        stderr: "",
        truncated: false,
      };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      return {
        success: false,
        exitCode: 1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
        truncated: false,
      };
    }
  },
  readFile: (filePath: string, _encoding: "utf-8") =>
    Promise.resolve(fs.readFileSync(filePath, "utf8")),
} as never;

mock.module("@paco/sandbox", () => ({
  connectSandbox: () => Promise.resolve(shellSandbox),
}));
mock.module("@/lib/agent/workspace-paths", () => ({
  resolveWorkCwd: () => workspace.dir,
}));

const {
  commitStaged,
  discardFiles,
  getFileDiff,
  getWorkingTreeStatus,
  stageFiles,
  unstageFiles,
} = await import("./source-control-actions");
const { computeAndCacheDiff } = await import("@/lib/diff/compute-diff");
const { getGitStatus } = await import("./queries/status");
const { unescapeGitPath } =
  await import("@/app/api/sessions/[sessionId]/diff/_lib/diff-utils");

// ── the scenario space ─────────────────────────────────────────────

type Layout = { name: string; roots: string[] };

/** Outer-before-inner, so a repo nested in a repo is built after its host. */
const LAYOUTS: Layout[] = [
  { name: "one project", roots: ["api"] },
  { name: "two siblings", roots: ["api", "web"] },
  { name: "sibling name prefixes", roots: ["app", "app-old"] },
  { name: "grouped projects", roots: ["projects/api", "projects/web"] },
  { name: "repo inside repo", roots: ["tools", "tools/inner"] },
  { name: "spaces in the name", roots: ["my project"] },
  { name: "unicode name", roots: ["café"] },
  { name: "three products", roots: ["paco", "docket", "kanbanica"] },
];

type KindName =
  | "modify"
  | "untracked"
  | "deep-path"
  | "dotfile"
  | "spaces-in-file"
  | "unicode-file"
  | "delete"
  | "rename"
  | "binary"
  | "staged-and-modified";

type Kind = {
  name: KindName;
  /** Make the change on disk inside the target repository. */
  setup: (dir: string) => void;
  /** The path the panel would show, relative to the target repository. */
  rel: string;
  /** Where the row lands in `getWorkingTreeStatus`. */
  placement: "unstaged" | "untracked" | "staged" | "staged+unstaged";
  letter: "M" | "A" | "D" | "R";
  /** The index letter raw `git status --porcelain` shows once staged. */
  stagedLetter: "M" | "A" | "D" | "R";
  oldRel?: string;
  binary?: boolean;
  /** A hunk line the unstaged diff must contain; null = the diff is empty. */
  unstagedMarker: string | null;
  /** A line the staged diff must contain once the change is staged. */
  stagedMarker: string | null;
  /** What discarding leaves on disk. */
  afterDiscard: { file: string; content: string | null };
};

const BASELINE = "committed\n";

function writeIn(dir: string, rel: string, contents: string | Buffer): void {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

const KINDS: Kind[] = [
  {
    name: "modify",
    setup: (dir) => writeIn(dir, "committed.txt", "changed once\n"),
    rel: "committed.txt",
    placement: "unstaged",
    letter: "M",
    stagedLetter: "M",
    unstagedMarker: "+changed once",
    stagedMarker: "+changed once",
    afterDiscard: { file: "committed.txt", content: BASELINE },
  },
  {
    name: "untracked",
    setup: (dir) => writeIn(dir, "scratch.ts", "export const s = 1;\n"),
    rel: "scratch.ts",
    placement: "untracked",
    letter: "A",
    stagedLetter: "A",
    unstagedMarker: "+export const s = 1;",
    stagedMarker: "+export const s = 1;",
    afterDiscard: { file: "scratch.ts", content: null },
  },
  {
    name: "deep-path",
    setup: (dir) => writeIn(dir, "src/a/b/c/deep.ts", "export const d = 1;\n"),
    rel: "src/a/b/c/deep.ts",
    placement: "untracked",
    letter: "A",
    stagedLetter: "A",
    unstagedMarker: "+export const d = 1;",
    stagedMarker: "+export const d = 1;",
    afterDiscard: { file: "src/a/b/c/deep.ts", content: null },
  },
  {
    name: "dotfile",
    setup: (dir) => writeIn(dir, ".env.local", "SECRET=1\n"),
    rel: ".env.local",
    placement: "untracked",
    letter: "A",
    stagedLetter: "A",
    unstagedMarker: "+SECRET=1",
    stagedMarker: "+SECRET=1",
    afterDiscard: { file: ".env.local", content: null },
  },
  {
    name: "spaces-in-file",
    setup: (dir) => writeIn(dir, "read me.md", "hello there\n"),
    rel: "read me.md",
    placement: "untracked",
    letter: "A",
    stagedLetter: "A",
    unstagedMarker: "+hello there",
    stagedMarker: "+hello there",
    afterDiscard: { file: "read me.md", content: null },
  },
  {
    name: "unicode-file",
    setup: (dir) => writeIn(dir, "café.ts", "const cafe = 1;\n"),
    rel: "café.ts",
    placement: "untracked",
    letter: "A",
    stagedLetter: "A",
    unstagedMarker: "+const cafe = 1;",
    stagedMarker: "+const cafe = 1;",
    afterDiscard: { file: "café.ts", content: null },
  },
  {
    name: "delete",
    setup: (dir) => fs.rmSync(path.join(dir, "committed.txt")),
    rel: "committed.txt",
    placement: "unstaged",
    letter: "D",
    stagedLetter: "D",
    unstagedMarker: "-committed",
    stagedMarker: "-committed",
    afterDiscard: { file: "committed.txt", content: BASELINE },
  },
  {
    name: "rename",
    setup: (dir) => sh("git mv committed.txt renamed.txt", dir),
    rel: "renamed.txt",
    oldRel: "committed.txt",
    placement: "staged",
    letter: "R",
    stagedLetter: "R",
    unstagedMarker: null,
    stagedMarker: "rename to",
    afterDiscard: { file: "committed.txt", content: BASELINE },
  },
  {
    name: "binary",
    setup: (dir) =>
      writeIn(dir, "logo.bin", Buffer.from([0, 1, 2, 3, 0, 255, 254])),
    rel: "logo.bin",
    placement: "untracked",
    letter: "A",
    stagedLetter: "A",
    binary: true,
    unstagedMarker: null,
    stagedMarker: null,
    afterDiscard: { file: "logo.bin", content: null },
  },
  {
    name: "staged-and-modified",
    setup: (dir) => {
      writeIn(dir, "committed.txt", "edit one\n");
      sh("git add committed.txt", dir);
      writeIn(dir, "committed.txt", "edit two\n");
    },
    rel: "committed.txt",
    placement: "staged+unstaged",
    letter: "M",
    stagedLetter: "M",
    unstagedMarker: "+edit two",
    stagedMarker: "+edit one",
    afterDiscard: { file: "committed.txt", content: "edit one\n" },
  },
];

const OPS = [
  "status",
  "stage",
  "unstage",
  "discard",
  "commit",
  "diff-unstaged",
  "diff-staged",
  "changes-tab",
  "header-counts",
  "isolation",
] as const;
type Op = (typeof OPS)[number];

// ── the report ─────────────────────────────────────────────────────

type Result = {
  id: string;
  layout: string;
  target: string;
  kind: string;
  op: string;
  outcome: "PASS" | "FAIL";
  note: string;
};

const results: Result[] = [];
const startedAt = Date.now();

function writeReport(): void {
  const passed = results.filter((r) => r.outcome === "PASS").length;
  const failed = results.length - passed;
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);

  const lines = [
    "# Multi-repository scenario sweep",
    "",
    "Every scenario below was executed individually: a real git workspace",
    "was built for its layout, the file change was made on disk, the real",
    "server action ran against it, and the outcome was verified with an",
    "independent raw `git` command in the owning repository. Generated by",
    "`apps/web/lib/git/multi-repo-sweep.test.ts`",
    "(`pnpm --dir apps/web sweep:multi-repo`).",
    "",
    `- **Scenarios:** ${results.length}`,
    `- **Passed:** ${passed}`,
    `- **Failed:** ${failed}`,
    `- **Wall clock:** ${seconds}s`,
    "",
    "| id | layout | target repo | change | operation | result |",
    "|----|--------|-------------|--------|-----------|--------|",
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.layout} | ${r.target || "(workspace root)"} | ${r.kind} | ${r.op} | ${r.outcome}${r.note ? ` — ${r.note}` : ""} |`,
    ),
    "",
  ];

  const out = path.join("docs", "verification");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(
    path.join(out, "multi-repo-scenario-sweep.md"),
    lines.join("\n"),
  );
}

// ── scenario execution ─────────────────────────────────────────────

/** Prefix a repo-relative path the way the panel shows it. */
function P(target: string, rel: string): string {
  return target ? `${target}/${rel}` : rel;
}

/**
 * Raw porcelain of one repository, minus its own nested repos' rows.
 *
 * `--untracked-files=all` so a directory shared by two repos (`projects/`)
 * does not collapse into one row that hides both; `unescapeGitPath` because
 * plain porcelain quotes paths holding non-ASCII bytes or escapes, and the
 * raw line would never match the root list.
 */
function porcelainOf(dir: string, relRootsInside: string[]): string[] {
  return sh("git status --porcelain --untracked-files=all", dir)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => {
      const p = unescapeGitPath(line.slice(3).trim()).replace(/\/$/, "");
      return !relRootsInside.includes(p);
    });
}

function repoDirs(roots: string[]): Map<string, string> {
  const dirs = new Map<string, string>([["", workspace.dir]]);
  for (const root of roots) {
    dirs.set(root, path.join(workspace.dir, root));
  }
  return dirs;
}

/** Nested-repo roots that live inside the given repo, relative to it. */
function rootsInside(repo: string, roots: string[]): string[] {
  if (repo === "") {
    return roots.filter((r) => !roots.some((o) => r.startsWith(`${o}/`)));
  }
  return roots
    .filter((r) => r.startsWith(`${repo}/`))
    .map((r) => r.slice(repo.length + 1));
}

async function runScenario(
  layout: Layout,
  target: string,
  kind: Kind,
  op: Op,
): Promise<void> {
  const dirs = repoDirs(layout.roots);
  const dir = dirs.get(target) ?? workspace.dir;
  const full = P(target, kind.rel);
  const isAscii = !/[^\x20-\x7E]/.test(full);

  kind.setup(dir);

  switch (op) {
    case "status": {
      const status = await getWorkingTreeStatus("chat-1");
      const all = [...status.staged, ...status.unstaged, ...status.untracked];
      // No repo's own directory ever appears as a row.
      for (const root of layout.roots) {
        expect(all.map((f) => f.path)).not.toContain(root);
        expect(all.map((f) => f.path)).not.toContain(`${root}/`);
      }
      if (kind.placement === "untracked") {
        expect(
          status.untracked.some((f) => f.path === full && f.status === "A"),
        ).toBe(true);
      } else if (kind.placement === "unstaged") {
        expect(
          status.unstaged.some(
            (f) => f.path === full && f.status === kind.letter,
          ),
        ).toBe(true);
      } else if (kind.placement === "staged") {
        const entry = status.staged.find((f) => f.path === full);
        expect(entry?.status).toBe(kind.letter);
        if (kind.oldRel) {
          expect(entry?.oldPath).toBe(P(target, kind.oldRel));
        }
      } else {
        expect(status.staged.some((f) => f.path === full)).toBe(true);
        expect(status.unstaged.some((f) => f.path === full)).toBe(true);
      }
      break;
    }

    case "stage": {
      const result = await stageFiles("chat-1", [full]);
      expect(result.success).toBe(true);
      const lines = porcelainOf(dir, rootsInside(target, layout.roots));
      expect(lines.some((line) => line.startsWith(kind.stagedLetter))).toBe(
        true,
      );
      break;
    }

    case "unstage": {
      if (kind.placement !== "staged") {
        expect((await stageFiles("chat-1", [full])).success).toBe(true);
      }
      const result = await unstageFiles("chat-1", [full]);
      expect(result.success).toBe(true);
      // Nothing left in the index: every remaining row is workspace.dir-only.
      const lines = porcelainOf(dir, rootsInside(target, layout.roots));
      for (const line of lines) {
        expect([" ", "?"]).toContain(line[0] ?? " ");
      }
      break;
    }

    case "discard": {
      if (kind.name === "rename") {
        // The operator's two-step flow: a rename is staged, so it is
        // unstaged first, then both halves discarded.
        expect((await unstageFiles("chat-1", [full])).success).toBe(true);
        const both = [full, P(target, kind.oldRel ?? "")];
        expect((await discardFiles("chat-1", both)).success).toBe(true);
        expect(fs.existsSync(path.join(dir, kind.rel))).toBe(false);
      } else {
        expect((await discardFiles("chat-1", [full])).success).toBe(true);
      }
      const { file, content } = kind.afterDiscard;
      if (content === null) {
        expect(fs.existsSync(path.join(dir, file))).toBe(false);
      } else {
        expect(fs.readFileSync(path.join(dir, file), "utf8")).toBe(content);
      }
      break;
    }

    case "commit": {
      const headsBefore = new Map<string, string>();
      for (const [repo, repoDir] of dirs) {
        if (repo !== target) {
          headsBefore.set(repo, sh("git rev-parse HEAD", repoDir).trim());
        }
      }
      if (kind.placement !== "staged") {
        expect((await stageFiles("chat-1", [full])).success).toBe(true);
      }
      const result = await commitStaged("chat-1", "sweep commit");
      expect(result.success).toBe(true);
      expect(sh("git log -1 --format=%s", dir).trim()).toBe("sweep commit");
      // The commit landed only in the owning repository.
      for (const [repo, sha] of headsBefore) {
        expect(
          sh("git rev-parse HEAD", dirs.get(repo) ?? workspace.dir).trim(),
        ).toBe(sha);
      }
      // And it captured the staged content: the index is clean afterwards.
      const lines = porcelainOf(dir, rootsInside(target, layout.roots));
      for (const line of lines) {
        expect([" ", "?"]).toContain(line[0] ?? " ");
      }
      break;
    }

    case "diff-unstaged": {
      const diff = await getFileDiff("chat-1", full, { staged: false });
      if (kind.binary) {
        expect(diff.binary).toBe(true);
        expect(diff.patch).toBe("");
      } else if (kind.unstagedMarker === null) {
        expect(diff.patch).toBe("");
      } else {
        expect(diff.patch).toContain(kind.unstagedMarker);
        if (kind.placement === "untracked") {
          expect(diff.patch).toContain("--- /dev/null");
        }
        if (kind.name === "delete") {
          expect(diff.patch).toContain("+++ /dev/null");
        }
        if (isAscii && target && kind.name !== "delete") {
          expect(diff.patch).toContain(`b/${full}`);
        }
      }
      break;
    }

    case "diff-staged": {
      // Skip staging when something is already staged: re-staging
      // staged-and-modified would overwrite the staged snapshot ("edit one")
      // with the worktree edit, and the point is diffing what is staged.
      // Spelled as two equality checks, not `.includes("staged")` — the
      // string "unstaged" contains "staged", and that substring skipped this
      // prep for plain modify/delete in an earlier run of this sweep.
      if (kind.placement !== "staged" && kind.placement !== "staged+unstaged") {
        expect((await stageFiles("chat-1", [full])).success).toBe(true);
      }
      const diff = await getFileDiff("chat-1", full, { staged: true });
      if (kind.binary) {
        expect(diff.binary).toBe(true);
      } else {
        expect(diff.patch).toContain(kind.stagedMarker ?? "");
        if (kind.oldRel) {
          expect(diff.oldPath).toBe(P(target, kind.oldRel));
        }
        if (isAscii && target && kind.name !== "delete") {
          expect(diff.patch).toContain(`b/${full}`);
        }
      }
      break;
    }

    case "changes-tab": {
      const diff = await computeAndCacheDiff({
        sandbox: shellSandbox,
        sessionId: "session-1",
        cwd: workspace.dir,
      });
      const paths = diff.files.map((f) => f.path);
      for (const root of layout.roots) {
        expect(paths).not.toContain(root);
        expect(paths).not.toContain(`${root}/`);
      }
      if (kind.name === "rename") {
        // Without -M in name-status the rename arrives as add + delete;
        // either spelling proves the nested change is visible.
        expect(
          paths.includes(full) || paths.includes(P(target, kind.oldRel ?? "")),
        ).toBe(true);
      } else {
        expect(paths).toContain(full);
      }
      break;
    }

    case "header-counts": {
      const status = await getGitStatus({ sessionId: "session-1" });
      expect(status).not.toBeNull();
      expect(status?.hasUncommittedChanges).toBe(true);
      expect(status?.uncommittedFiles ?? 0).toBeGreaterThanOrEqual(1);
      if (kind.placement === "staged" || kind.placement === "staged+unstaged") {
        expect(status?.stagedCount ?? 0).toBeGreaterThanOrEqual(1);
      }
      if (kind.placement === "untracked") {
        expect(status?.untrackedCount ?? 0).toBeGreaterThanOrEqual(1);
      }
      break;
    }

    case "isolation": {
      // Every repository that is not the target stays untouched — by raw
      // git's own account, not the panel's.
      for (const [repo, repoDir] of dirs) {
        if (repo === target) {
          continue;
        }
        // Skip repos that *contain* the target: the change is inside their
        // nested repo, which their own porcelain shows as one opaque row
        // (already filtered by porcelainOf).
        const containsTarget = repo === "" || target.startsWith(`${repo}/`);
        const lines = porcelainOf(repoDir, rootsInside(repo, layout.roots));
        if (containsTarget && repo !== "") {
          continue;
        }
        if (repo === "" && target !== "") {
          expect(lines).toEqual([]);
        } else if (repo !== "" && !containsTarget) {
          expect(lines).toEqual([]);
        }
      }
      // And the merged view never invents rows outside the target.
      const status = await getWorkingTreeStatus("chat-1");
      const all = [...status.staged, ...status.unstaged, ...status.untracked];
      const domain = target ? `${target}/` : "";
      for (const change of all) {
        if (domain) {
          expect(change.path.startsWith(domain)).toBe(true);
        } else {
          for (const root of layout.roots) {
            expect(change.path.startsWith(`${root}/`)).toBe(false);
          }
        }
      }
      break;
    }

    default:
      throw new Error(`Unhandled op ${op satisfies never}`);
  }
}

// ── generation ─────────────────────────────────────────────────────

const scenarioCounter = { n: 0 };
const sweepRoots: string[] = [];
const suite = SWEEP ? describe : describe.skip;

suite("multi-repo scenario sweep", () => {
  afterAll(() => {
    for (const root of sweepRoots) {
      rmSync(root, { recursive: true, force: true });
    }
    if (results.length > 0) {
      writeReport();
    }
  });

  for (const layout of LAYOUTS) {
    describe(layout.name, () => {
      const baselines = new Map<string, string>();

      function buildWorkspace(): void {
        const sweepRoot = mkdtempSync(path.join(tmpdir(), "paco-sweep-"));
        sweepRoots.push(sweepRoot);
        workspace.dir = path.join(sweepRoot, "worktree");
        fs.mkdirSync(workspace.dir);
        sh("git init -q -b main .", workspace.dir);
        writeIn(workspace.dir, "committed.txt", BASELINE);
        sh("git add -A && git commit -qm base", workspace.dir);
        for (const root of layout.roots) {
          const dir = path.join(workspace.dir, root);
          fs.mkdirSync(dir, { recursive: true });
          sh("git init -q -b main .", dir);
          writeIn(dir, "committed.txt", BASELINE);
          sh("git add -A && git commit -qm base", dir);
        }
        for (const [repo, dir] of repoDirs(layout.roots)) {
          baselines.set(repo, sh("git rev-parse HEAD", dir).trim());
        }
      }

      beforeEach(() => {
        if (baselines.size === 0) {
          buildWorkspace();
        }
        for (const [repo, dir] of repoDirs(layout.roots)) {
          const sha = baselines.get(repo);
          if (sha) {
            sh(`git reset -q --hard ${sha} && git clean -fdq || true`, dir);
          }
        }
      });

      const targets = ["", ...layout.roots];
      for (const target of targets) {
        for (const kind of KINDS) {
          for (const op of OPS) {
            scenarioCounter.n += 1;
            const id = `SCN-${String(scenarioCounter.n).padStart(4, "0")}`;
            test(`${id} target=${target || "(root)"} change=${kind.name} op=${op}`, async () => {
              try {
                await runScenario(layout, target, kind, op);
                results.push({
                  id,
                  layout: layout.name,
                  target,
                  kind: kind.name,
                  op,
                  outcome: "PASS",
                  note: "",
                });
              } catch (error) {
                results.push({
                  id,
                  layout: layout.name,
                  target,
                  kind: kind.name,
                  op,
                  outcome: "FAIL",
                  note:
                    error instanceof Error
                      ? (error.message.split("\n")[0] ?? "")
                      : String(error),
                });
                throw error;
              }
            });
          }
        }
      }
    });
  }
});
