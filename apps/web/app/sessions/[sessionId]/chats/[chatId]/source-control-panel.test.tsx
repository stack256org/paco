import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkingTreeStatus } from "./source-control-contract";
import {
  SourceControlPanel,
  type SourceControlPanelProps,
} from "./source-control-panel";

const noop = () => {
  // no-op: only the rendered markup is asserted here
};

function workingTree(
  overrides: Partial<WorkingTreeStatus> = {},
): WorkingTreeStatus {
  return {
    aheadOfBase: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    ...overrides,
  };
}

function render(overrides: Partial<SourceControlPanelProps> = {}) {
  const props: SourceControlPanelProps = {
    busyKeys: new Set<string>(),
    canMutate: true,
    commitMessage: "",
    committing: false,
    diff: <div>DIFF PANE</div>,
    error: null,
    loading: false,
    onCommit: noop,
    onCommitMessageChange: noop,
    onDiscard: noop,
    onRefresh: noop,
    onSelect: noop,
    onStage: noop,
    onUnstage: noop,
    refreshing: false,
    selected: null,
    status: workingTree(),
    ...overrides,
  };
  return renderToStaticMarkup(<SourceControlPanel {...props} />);
}

/** How many times a string occurs, so a doubled row can be told from a single one. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("SourceControlPanel — the two lists", () => {
  const status = workingTree({
    staged: [
      { path: "apps/web/lib/parser.ts", status: "M" },
      { path: "apps/web/lib/tokens.ts", status: "A" },
    ],
    unstaged: [{ path: "apps/web/app/page.tsx", status: "M" }],
    untracked: [{ path: "scratch/notes.md", status: "A" }],
  });

  test("renders both headings with their own counts", () => {
    const html = render({ status });

    expect(html).toContain("Staged changes");
    expect(html).toContain("Changes");
    // Two staged, and one unstaged plus one untracked in the working list.
    expect(html).toContain(">2</span>");
    expect(html).toContain(">4</span>");
  });

  test("lists every changed path, flat, with no directory tree", () => {
    const html = render({ status });

    expect(html).toContain("parser.ts");
    expect(html).toContain("apps/web/lib");
    expect(html).toContain("page.tsx");
    expect(html).toContain("notes.md");
    expect(html).toContain("scratch");
  });

  /*
   * Git sends an untracked file as `A`. The row still shows `U`, as VS Code
   * does — otherwise an untracked file and the staged addition two rows above
   * it carry the same mark, and the whole point of the two lists is that those
   * are not the same thing.
   */
  test("marks an untracked file U in green, though git called it A", () => {
    const html = render({ status });

    expect(html).toContain("text-success");
    expect(html).toContain("Untracked");
    expect(html).toContain(">U</span>");
  });

  test("still marks a staged addition A", () => {
    const html = render({ status });

    expect(html).toContain("Added");
    expect(html).toContain(">A</span>");
  });

  test("marks a conflict U in red, not as a new file", () => {
    const html = render({
      status: workingTree({
        unstaged: [{ path: "merge/target.ts", status: "U" }],
      }),
    });

    expect(html).toContain("Conflicted");
    expect(html).toContain("text-error");
    expect(html).not.toContain("Untracked");
  });

  test("offers stage and discard on a working row, and unstage on a staged one", () => {
    const html = render({ status });

    expect(html).toContain("Stage apps/web/app/page.tsx");
    expect(html).toContain("Discard changes in apps/web/app/page.tsx");
    expect(html).toContain("Unstage apps/web/lib/parser.ts");
    // The staged row offers no Stage button — the label would end at the
    // closing quote, which is what tells it apart from "Unstage ...".
    expect(html).not.toContain('"Stage apps/web/lib/parser.ts"');
  });

  test("offers the three section-wide actions", () => {
    const html = render({ status });

    expect(html).toContain("Unstage all changes");
    expect(html).toContain("Stage all changes");
    expect(html).toContain("Discard all changes");
  });
});

describe("SourceControlPanel — a file staged and then modified again", () => {
  const path = "apps/web/app/page.tsx";
  const status = workingTree({
    staged: [{ path, status: "M" }],
    unstaged: [{ path, status: "M" }],
  });

  test("shows the file once under each heading, as VS Code does", () => {
    const html = render({ status });

    expect(occurrences(html, "page.tsx")).toBeGreaterThanOrEqual(2);
    expect(html).toContain(">1</span>");
  });

  test("the two rows are different rows, offering different actions", () => {
    const html = render({ status });

    expect(html).toContain(`Unstage ${path}`);
    expect(html).toContain(`Stage ${path}`);
    expect(html).toContain(`Discard changes in ${path}`);
  });

  test("selecting the staged row does not also highlight the working one", () => {
    const html = render({ selected: { path, staged: true }, status });

    // The selected row is the only one carrying the selection background.
    expect(occurrences(html, "bg-base-300")).toBe(1);
  });
});

describe("SourceControlPanel — renames", () => {
  const status = workingTree({
    staged: [
      {
        oldPath: "apps/web/lib/old-name.ts",
        path: "apps/web/lib/new-name.ts",
        status: "R",
      },
    ],
  });

  test("shows the old path and the new one, in that order", () => {
    const html = render({ status });
    const oldAt = html.indexOf("apps/web/lib/old-name.ts");
    const newAt = html.indexOf("new-name.ts");

    expect(oldAt).toBeGreaterThan(-1);
    expect(newAt).toBeGreaterThan(oldAt);
    expect(html).toContain("Renamed");
  });

  test("keeps both paths in full on the row's tooltip", () => {
    // The visible label shortens the old path first when the row is narrow, so
    // the tooltip is what guarantees both are always readable somewhere.
    expect(render({ status })).toContain(
      "apps/web/lib/old-name.ts → apps/web/lib/new-name.ts",
    );
  });
});

describe("SourceControlPanel — the commit box", () => {
  const staged = workingTree({
    staged: [{ path: "a.ts", status: "M" }],
  });

  test("is disabled, and says why, with nothing staged", () => {
    const html = render({
      commitMessage: "a real message",
      status: workingTree({ unstaged: [{ path: "a.ts", status: "M" }] }),
    });

    expect(html).toContain("disabled");
    expect(html).toContain("Stage a file first");
  });

  test("is disabled, and says why, with an empty message", () => {
    const html = render({ commitMessage: "   ", status: staged });

    expect(html).toContain("disabled");
    expect(html).toContain("Write a commit message");
  });

  test("is enabled once something is staged and a message is written", () => {
    const html = render({
      commitMessage: "tighten the parser",
      status: staged,
    });

    expect(html).toContain("Commit 1 staged");
    expect(html).not.toContain("Write a commit message");
    expect(html).not.toContain("Stage a file first");
  });

  test("explains itself rather than failing when the workspace is offline", () => {
    const html = render({
      canMutate: false,
      commitMessage: "tighten the parser",
      status: staged,
    });

    expect(html).toContain("workspace is offline");
    expect(html).toContain("disabled");
  });

  test("shows a busy label while a commit is in flight", () => {
    const html = render({
      commitMessage: "tighten the parser",
      committing: true,
      status: staged,
    });

    expect(html).toContain("Committing…");
    expect(html).toContain("animate-spin");
  });

  test("uses a plain paragraph for the reason, never daisyUI's inline-flex label", () => {
    const html = render({ commitMessage: "", status: staged });

    expect(html).toContain("<p");
    expect(html).not.toContain('class="label"');
  });
});

describe("SourceControlPanel — the states that are not a list", () => {
  test("reads as clean, not broken, when nothing has changed", () => {
    const html = render({ status: workingTree() });

    expect(html).toContain("No changes to commit");
    expect(html).toContain("matches the last commit");
    expect(html).not.toContain("Staged changes");
  });

  test("says it is reading the workspace on a first load", () => {
    const html = render({ loading: true, status: null });

    expect(html).toContain("Reading the workspace…");
    expect(html).not.toContain("No changes to commit");
  });

  test("shows a failure instead of an empty state, and lets a long one wrap", () => {
    const html = render({
      error: "Could not read the workspace: the sandbox is not running.",
      status: null,
    });

    expect(html).toContain("the sandbox is not running");
    expect(html).toContain("wrap-anywhere");
    expect(html).not.toContain("No changes to commit");
  });

  test("mentions commits the base branch does not have", () => {
    const html = render({
      status: workingTree({ aheadOfBase: 3 }),
    });

    expect(html).toContain("3 commits");
    expect(html).toContain("not on the base branch");
  });

  test("locks every action while the workspace is offline", () => {
    const html = render({
      canMutate: false,
      status: workingTree({ unstaged: [{ path: "a.ts", status: "M" }] }),
    });

    expect(occurrences(html, "disabled")).toBeGreaterThanOrEqual(4);
  });
});

describe("SourceControlPanel — layout", () => {
  test("renders the diff pane it was handed", () => {
    const html = render({ diff: <p>PANE CONTENT</p> });

    expect(html).toContain("PANE CONTENT");
  });

  test("gives every flex child holding a path room to shrink", () => {
    const html = render({
      status: workingTree({
        unstaged: [
          {
            path: "apps/web/app/sessions/chats/a-very-long-name.tsx",
            status: "M",
          },
        ],
      }),
    });

    expect(html).toContain("min-w-0");
    expect(html).toContain("truncate");
  });

  test("hands the whole pane to the diff on a narrow layout once a file is open", () => {
    const open = render({
      selected: { path: "a.ts", staged: false },
      status: workingTree({ unstaged: [{ path: "a.ts", status: "M" }] }),
    });
    const closed = render({
      status: workingTree({ unstaged: [{ path: "a.ts", status: "M" }] }),
    });

    expect(open).toContain("hidden lg:flex");
    expect(closed).toContain("hidden lg:flex");
    // Both halves stay in the markup either way, so a half-typed commit
    // message survives a trip into a file and back.
    expect(open).toContain("Commit");
    expect(closed).toContain("DIFF PANE");
  });
});
