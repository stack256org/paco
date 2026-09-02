import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  DISCOVER_NESTED_REPOS_COMMAND,
  discoverNestedRepos,
  groupByOwner,
  isNestedRepoRootRow,
  MAX_NESTED_REPOS,
  ownerOf,
  parseNestedRepoRoots,
  prefixPatchPaths,
  prefixPath,
  repoCwd,
} from "./nested-repos";

/**
 * Two halves. The generated matrix drives the pure routing functions across
 * every workspace layout customers actually build — flat, deep, nested inside
 * nested, sibling directories whose names prefix each other — crossed with
 * every kind of path a status can produce. The integration half runs the real
 * `find` command against real directories, because the matrix can only prove
 * the parser matches itself.
 */

// ── the layouts customers build ────────────────────────────────────

type Layout = { name: string; roots: string[] };

const LAYOUTS: Layout[] = [
  { name: "no nested repos", roots: [] },
  { name: "one project", roots: ["api"] },
  { name: "two siblings", roots: ["api", "web"] },
  {
    name: "many products side by side",
    roots: ["paco", "docket", "kanbanica", "shapio", "pagevo"],
  },
  // The trap: `app` must not claim `app-old/…` or `app.config/…`.
  { name: "sibling name prefixes", roots: ["app", "app-old", "app.config"] },
  { name: "hyphen and dot names", roots: ["my-app", "v2.0"] },
  {
    name: "grouped under a directory",
    roots: ["projects/api", "projects/web"],
  },
  { name: "deeply grouped", roots: ["clients/acme/site", "clients/zed/site"] },
  // A repository inside another repository: the inner one must win.
  { name: "nested inside nested", roots: ["tools/inner", "tools"] },
  { name: "three levels of nesting", roots: ["a/b/c", "a/b", "a"] },
  { name: "root name contains another", roots: ["web", "website"] },
  { name: "spaces in names", roots: ["my project", "docs site"] },
  { name: "unicode names", roots: ["café", "домен"] },
  {
    name: "mixed depths",
    roots: ["packages/core/generated", "vendor/lib", "site"],
  },
];

/** Longest-first, matching `parseNestedRepoRoots`'s contract. */
function sorted(roots: string[]): string[] {
  return [...roots].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/** The paths one layout's status output can contain. */
function candidatePaths(layout: Layout): {
  path: string;
  expectedRoot: string;
}[] {
  const candidates: { path: string; expectedRoot: string }[] = [
    // Parent-owned files, including names that resemble the roots.
    { path: "README.md", expectedRoot: "" },
    { path: "src/index.ts", expectedRoot: "" },
    { path: "deeply/nested/dir/file.txt", expectedRoot: "" },
  ];

  for (const root of layout.roots) {
    // A file at the repository's top level, and files deeper in — every
    // shape a real project produces: sources, dotfiles, spaces, unicode,
    // build config, a dependency tree, a path that itself says `.git`-ish
    // things without being one.
    candidates.push({ path: `${root}/file.txt`, expectedRoot: root });
    candidates.push({ path: `${root}/src/deep/mod.rs`, expectedRoot: root });
    candidates.push({
      path: `${root}/a/b/c/d/e/five-deep.ts`,
      expectedRoot: root,
    });
    candidates.push({ path: `${root}/.env.local`, expectedRoot: root });
    candidates.push({
      path: `${root}/.github/workflows/ci.yml`,
      expectedRoot: root,
    });
    candidates.push({
      path: `${root}/docs/read me first.md`,
      expectedRoot: root,
    });
    candidates.push({ path: `${root}/src/café.ts`, expectedRoot: root });
    candidates.push({ path: `${root}/package.json`, expectedRoot: root });
    candidates.push({
      path: `${root}/node_modules/dep/index.js`,
      expectedRoot: root,
    });
    candidates.push({ path: `${root}/gitignore.txt`, expectedRoot: root });
    // A file whose *name* is the root's last segment, inside the repo.
    const last = root.split("/").at(-1) ?? root;
    candidates.push({ path: `${root}/${last}`, expectedRoot: root });
    // Sibling traps: the root's name extended is NOT inside the root.
    if (!layout.roots.some((other) => `${root}x` === other)) {
      const trapOwner = layout.roots
        .filter((other) => `${root}x/readme`.startsWith(`${other}/`))
        .sort((a, b) => b.length - a.length)[0];
      candidates.push({
        path: `${root}x/readme`,
        expectedRoot: trapOwner ?? "",
      });
    }
    // A parent file that shares the root as a plain name (no slash after).
    if (!root.includes("/")) {
      candidates.push({ path: `${root}.md`, expectedRoot: "" });
    }
  }

  // For nested-inside-nested layouts, files between the two boundaries.
  for (const root of layout.roots) {
    for (const inner of layout.roots) {
      if (inner !== root && inner.startsWith(`${root}/`)) {
        // Directly inside the outer repo, beside the inner one.
        candidates.push({ path: `${root}/beside.txt`, expectedRoot: root });
        // Inside the inner repo.
        candidates.push({
          path: `${inner}/inner-file.txt`,
          expectedRoot: inner,
        });
      }
    }
  }

  return candidates;
}

// ── the generated matrix ───────────────────────────────────────────

describe("routing matrix", () => {
  const tally = { scenarios: 0 };

  for (const layout of LAYOUTS) {
    const roots = sorted(layout.roots);

    describe(layout.name, () => {
      for (const { path: candidate, expectedRoot } of candidatePaths(layout)) {
        test(`ownerOf routes ${candidate} → ${expectedRoot || "(parent)"}`, () => {
          const owner = ownerOf(candidate, roots);
          tally.scenarios += 1;
          expect(owner.root).toBe(expectedRoot);

          // rel + root must reconstruct the original path exactly. (This is
          // the whole invariant: a rel that *begins* with the root's own name
          // is legal — `a/b/c` the repo can contain `a/b/c/…` the directory.)
          tally.scenarios += 1;
          expect(prefixPath(owner.root, owner.rel)).toBe(candidate);
        });
      }

      test("groupByOwner partitions without loss or duplication", () => {
        const candidates = candidatePaths(layout);
        const groups = groupByOwner(
          candidates.map((candidate) => candidate.path),
          roots,
        );

        const regrouped: string[] = [];
        for (const [root, rels] of groups) {
          for (const rel of rels) {
            regrouped.push(prefixPath(root, rel));
          }
        }
        tally.scenarios += 1;
        expect(regrouped.sort()).toEqual(
          candidates.map((candidate) => candidate.path).sort(),
        );
      });

      test("every root is its own row, with and without a trailing slash", () => {
        for (const root of layout.roots) {
          tally.scenarios += 3;
          expect(isNestedRepoRootRow(root, roots)).toBe(true);
          expect(isNestedRepoRootRow(`${root}/`, roots)).toBe(true);
          // A file inside is not the root's row.
          expect(isNestedRepoRootRow(`${root}/file`, roots)).toBe(false);
        }
        tally.scenarios += 1;
        expect(isNestedRepoRootRow("README.md", roots)).toBe(false);
      });

      test("repoCwd appends the root and leaves the parent alone", () => {
        tally.scenarios += 1;
        expect(repoCwd("/work/chats/c1", "")).toBe("/work/chats/c1");
        for (const root of layout.roots) {
          tally.scenarios += 1;
          expect(repoCwd("/work/chats/c1", root)).toBe(
            `/work/chats/c1/${root}`,
          );
        }
      });

      test("parseNestedRepoRoots round-trips this layout's find output", () => {
        const findOutput = layout.roots
          .map((root) => `./${root}/.git`)
          .join("\n");
        tally.scenarios += 1;
        expect(parseNestedRepoRoots(findOutput)).toEqual(roots);
      });
    });
  }

  test("the matrix is broad enough to trust", () => {
    // A regression that guts `candidatePaths` or `LAYOUTS` should fail loudly,
    // not quietly shrink the net.
    expect(tally.scenarios).toBeGreaterThan(500);
  });
});

// ── patch-header rewriting, across the same layouts ────────────────

describe("prefixPatchPaths matrix", () => {
  const headerCases: {
    name: string;
    build: (rel: string) => string;
    expected: (rel: string, prefixed: string) => string;
  }[] = [
    {
      name: "diff --git",
      build: (rel) => `diff --git a/${rel} b/${rel}`,
      expected: (_rel, prefixed) => `diff --git a/${prefixed} b/${prefixed}`,
    },
    {
      name: "minus header",
      build: (rel) => `--- a/${rel}`,
      expected: (_rel, prefixed) => `--- a/${prefixed}`,
    },
    {
      name: "plus header",
      build: (rel) => `+++ b/${rel}`,
      expected: (_rel, prefixed) => `+++ b/${prefixed}`,
    },
    {
      name: "rename pair",
      build: (rel) => `rename from ${rel}\nrename to ${rel}`,
      expected: (_rel, prefixed) =>
        `rename from ${prefixed}\nrename to ${prefixed}`,
    },
    {
      name: "copy pair",
      build: (rel) => `copy from ${rel}\ncopy to ${rel}`,
      expected: (_rel, prefixed) =>
        `copy from ${prefixed}\ncopy to ${prefixed}`,
    },
    {
      name: "binary marker",
      build: (rel) => `Binary files a/${rel} and b/${rel} differ`,
      expected: (_rel, prefixed) =>
        `Binary files a/${prefixed} and b/${prefixed} differ`,
    },
  ];

  const RELS = [
    "file.ts",
    "src/deep/mod.rs",
    "docs/read me.md",
    "café.ts",
    ".github/workflows/ci.yml",
    "a/b/c/d/e/five-deep.ts",
  ];

  for (const layout of LAYOUTS) {
    if (layout.roots.length === 0) {
      continue;
    }
    describe(layout.name, () => {
      for (const root of layout.roots) {
        for (const rel of RELS) {
          for (const headerCase of headerCases) {
            test(`${headerCase.name}: ${root} / ${rel}`, () => {
              const prefixed = `${root}/${rel}`;
              expect(prefixPatchPaths(headerCase.build(rel), root)).toBe(
                headerCase.expected(rel, prefixed),
              );
            });
          }
        }
      }
    });
  }

  test("hunk content lines are never rewritten", () => {
    const patch = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,2 +1,2 @@",
      "-old a/x.ts mention",
      "+new b/x.ts mention",
      " context --- a/x.ts",
    ].join("\n");
    const out = prefixPatchPaths(patch, "proj");
    expect(out).toContain("diff --git a/proj/x.ts b/proj/x.ts");
    expect(out).toContain("-old a/x.ts mention");
    expect(out).toContain("+new b/x.ts mention");
    expect(out).toContain(" context --- a/x.ts");
  });

  test("/dev/null sides survive verbatim", () => {
    const patch = [
      "diff --git a/new.ts b/new.ts",
      "--- /dev/null",
      "+++ b/new.ts",
    ].join("\n");
    const out = prefixPatchPaths(patch, "proj");
    expect(out).toContain("--- /dev/null");
    expect(out).toContain("+++ b/proj/new.ts");
  });

  test("the parent repository's patches pass through untouched", () => {
    const patch = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts";
    expect(prefixPatchPaths(patch, "")).toBe(patch);
  });
});

// ── parser edge cases ──────────────────────────────────────────────

describe("parseNestedRepoRoots", () => {
  test("drops the worktree's own .git", () => {
    expect(parseNestedRepoRoots("./.git\n./api/.git")).toEqual(["api"]);
  });

  test("drops node_modules entries even when find printed them", () => {
    const output = [
      "./node_modules",
      "./api/node_modules",
      "./api/node_modules/dep/.git",
      "./api/.git",
    ].join("\n");
    expect(parseNestedRepoRoots(output)).toEqual(["api"]);
  });

  test("ignores blank lines and non-.git lines", () => {
    expect(parseNestedRepoRoots("\n\n./api\n./api/.git\n\n")).toEqual(["api"]);
  });

  test("dedupes", () => {
    expect(parseNestedRepoRoots("./api/.git\n./api/.git")).toEqual(["api"]);
  });

  test("sorts longest-first so inner repos beat outer ones", () => {
    const roots = parseNestedRepoRoots(
      "./tools/.git\n./tools/inner/.git\n./api/.git",
    );
    expect(roots).toEqual(["tools/inner", "tools", "api"]);
    expect(ownerOf("tools/inner/file.ts", roots).root).toBe("tools/inner");
    expect(ownerOf("tools/other.ts", roots).root).toBe("tools");
  });

  test("caps the list deterministically", () => {
    const output = Array.from(
      { length: MAX_NESTED_REPOS + 15 },
      (_, index) => `./repo-${String(index).padStart(3, "0")}/.git`,
    ).join("\n");
    const roots = parseNestedRepoRoots(output);
    expect(roots).toHaveLength(MAX_NESTED_REPOS);
    // Same input, same survivors.
    expect(parseNestedRepoRoots(output)).toEqual(roots);
  });
});

// ── the real find, against real directories ────────────────────────

describe("discoverNestedRepos (real find)", () => {
  const shellSandbox = {
    exec: async (command: string, cwd: string) => {
      try {
        return {
          success: true,
          stdout: execFileSync("bash", ["-c", command], {
            cwd,
            encoding: "utf8",
          }),
          stderr: "",
        };
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string };
        return {
          success: false,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "",
        };
      }
    },
  };

  function withWorkspace(
    build: (root: string) => void,
    run: (root: string) => Promise<void>,
  ): Promise<void> {
    const root = mkdtempSync(path.join(tmpdir(), "paco-nested-"));
    build(root);
    return run(root).finally(() => {
      rmSync(root, { recursive: true, force: true });
    });
  }

  function gitDir(root: string, relative: string): void {
    fs.mkdirSync(path.join(root, relative, ".git"), { recursive: true });
  }

  test("finds nested repos and skips the worktree's own .git", async () => {
    await withWorkspace(
      (root) => {
        fs.mkdirSync(path.join(root, ".git"));
        gitDir(root, "api");
        gitDir(root, "projects/web");
      },
      async (root) => {
        expect(await discoverNestedRepos(shellSandbox, root)).toEqual([
          "projects/web",
          "api",
        ]);
      },
    );
  });

  test("a .git *file* (worktree/submodule checkout) also marks a repo", async () => {
    await withWorkspace(
      (root) => {
        // The worktree's own pointer is a file too — still excluded.
        fs.writeFileSync(path.join(root, ".git"), "gitdir: /elsewhere\n");
        fs.mkdirSync(path.join(root, "linked"));
        fs.writeFileSync(
          path.join(root, "linked", ".git"),
          "gitdir: /elsewhere/worktrees/linked\n",
        );
      },
      async (root) => {
        expect(await discoverNestedRepos(shellSandbox, root)).toEqual([
          "linked",
        ]);
      },
    );
  });

  test("never walks into node_modules", async () => {
    await withWorkspace(
      (root) => {
        gitDir(root, "api");
        gitDir(root, "api/node_modules/some-dep");
        gitDir(root, "node_modules/other-dep");
      },
      async (root) => {
        expect(await discoverNestedRepos(shellSandbox, root)).toEqual(["api"]);
      },
    );
  });

  test("never descends into a nested repo's own .git directory", async () => {
    await withWorkspace(
      (root) => {
        gitDir(root, "api");
        // A submodule's git dir lives under .git/modules — not a repo root.
        fs.mkdirSync(path.join(root, "api/.git/modules/sub/.git"), {
          recursive: true,
        });
      },
      async (root) => {
        expect(await discoverNestedRepos(shellSandbox, root)).toEqual(["api"]);
      },
    );
  });

  test("spaces and unicode in directory names survive the pipeline", async () => {
    await withWorkspace(
      (root) => {
        gitDir(root, "my project");
        gitDir(root, "café");
      },
      async (root) => {
        expect(await discoverNestedRepos(shellSandbox, root)).toEqual([
          "my project",
          "café",
        ]);
      },
    );
  });

  test("a failing find degrades to no nested repos", async () => {
    const broken = {
      exec: () =>
        Promise.resolve({ success: false, stdout: "", stderr: "boom" }),
    };
    expect(await discoverNestedRepos(broken, "/nowhere")).toEqual([]);
  });

  test("the command is the one the tests exercised", () => {
    // Guards against the constant drifting from what the shell sandbox ran.
    expect(DISCOVER_NESTED_REPOS_COMMAND).toContain("-name .git -prune -print");
    expect(DISCOVER_NESTED_REPOS_COMMAND).toContain(
      "-name node_modules -prune",
    );
  });
});
