import { describe, expect, test } from "bun:test";
import {
  ClaudeUIStreamMapper,
  normalizeToolInput,
  normalizeToolName,
  pendingRootPrefixLength,
  relativizeWorkspacePaths,
} from "./ui-stream.ts";

const WORKSPACE = "/Users/alice/.paco/workspaces/session_abc";

describe("normalizeToolName", () => {
  test("maps Claude Code tool names onto the renderer names", () => {
    expect(normalizeToolName("Bash")).toBe("bash");
    expect(normalizeToolName("AskUserQuestion")).toBe("ask_user_question");
    // Both spellings of the subagent tool render as the same task card.
    expect(normalizeToolName("Task")).toBe("task");
    expect(normalizeToolName("Agent")).toBe("task");
  });

  test("passes unknown tools through for the generic renderer", () => {
    expect(normalizeToolName("mcp__custom__thing")).toBe("mcp__custom__thing");
  });
});

describe("normalizeToolInput", () => {
  test("renames snake_case keys to the camelCase the renderers read", () => {
    expect(
      normalizeToolInput({
        file_path: "a.ts",
        old_string: "x",
        new_string: "y",
        replace_all: true,
      }),
    ).toEqual({
      filePath: "a.ts",
      oldString: "x",
      newString: "y",
      replaceAll: true,
    });
  });

  test("rewrites workspace paths as relative", () => {
    // Claude Code runs on the host and reports absolute host paths. Sending
    // those to the browser would both be meaningless there and leak the
    // operator's home directory.
    expect(
      normalizeToolInput(
        { file_path: `${WORKSPACE}/src/app.ts` },
        WORKSPACE,
      ) as Record<string, unknown>,
    ).toEqual({ filePath: "src/app.ts" });
  });

  test("maps the workspace root itself to '.'", () => {
    expect(normalizeToolInput({ cwd: WORKSPACE }, WORKSPACE)).toEqual({
      cwd: ".",
    });
  });

  test("tolerates a workspace root with a trailing slash", () => {
    expect(
      normalizeToolInput({ file_path: `${WORKSPACE}/a.ts` }, `${WORKSPACE}/`),
    ).toEqual({ filePath: "a.ts" });
  });

  test("leaves paths outside the workspace absolute", () => {
    // Shortening these would claim the file lives in the project when it does
    // not — `/etc/hosts` must keep reading as `/etc/hosts`.
    expect(normalizeToolInput({ file_path: "/etc/hosts" }, WORKSPACE)).toEqual({
      filePath: "/etc/hosts",
    });
  });

  test("does not treat a sibling directory as inside the workspace", () => {
    const sibling = `${WORKSPACE}-other/secret.ts`;

    expect(normalizeToolInput({ file_path: sibling }, WORKSPACE)).toEqual({
      filePath: sibling,
    });
  });

  test("only rewrites path-valued keys", () => {
    // A command that happens to mention the workspace path is not a path.
    expect(
      normalizeToolInput({ command: `ls ${WORKSPACE}` }, WORKSPACE),
    ).toEqual({ command: `ls ${WORKSPACE}` });
  });

  test("leaves paths untouched when no workspace root is known", () => {
    expect(normalizeToolInput({ file_path: `${WORKSPACE}/a.ts` })).toEqual({
      filePath: `${WORKSPACE}/a.ts`,
    });
  });

  test("passes non-object inputs through", () => {
    expect(normalizeToolInput(null)).toBeNull();
    expect(normalizeToolInput("text")).toBe("text");
    expect(normalizeToolInput([1, 2])).toEqual([1, 2]);
  });
});

describe("relativizeWorkspacePaths", () => {
  test("strips the workspace root out of tool result prose", () => {
    // The Write tool answers with an absolute host path, which is the form the
    // leak actually took — rewriting only input fields left this on screen.
    expect(
      relativizeWorkspacePaths(
        `File created successfully at: ${WORKSPACE}/src/app.ts`,
        WORKSPACE,
      ),
    ).toBe("File created successfully at: src/app.ts");
  });

  test("handles several occurrences in one blob", () => {
    expect(
      relativizeWorkspacePaths(
        `${WORKSPACE}/a.ts and ${WORKSPACE}/b.ts`,
        WORKSPACE,
      ),
    ).toBe("a.ts and b.ts");
  });

  test("rewrites a bare workspace root to '.'", () => {
    expect(relativizeWorkspacePaths(`cwd is ${WORKSPACE}`, WORKSPACE)).toBe(
      "cwd is .",
    );
  });

  test("tolerates a trailing slash on the root", () => {
    expect(relativizeWorkspacePaths(`${WORKSPACE}/a.ts`, `${WORKSPACE}/`)).toBe(
      "a.ts",
    );
  });

  test("leaves unrelated absolute paths intact", () => {
    expect(relativizeWorkspacePaths("see /etc/hosts", WORKSPACE)).toBe(
      "see /etc/hosts",
    );
  });

  test("is a no-op without a workspace root", () => {
    expect(relativizeWorkspacePaths(`${WORKSPACE}/a.ts`)).toBe(
      `${WORKSPACE}/a.ts`,
    );
  });
});

describe("pendingRootPrefixLength", () => {
  test("holds back a tail that could still become the target", () => {
    expect(
      pendingRootPrefixLength("returned `/Users/alice/.paco", `${WORKSPACE}/`),
    ).toBe("/Users/alice/.paco".length);
  });

  test("holds back nothing for ordinary text", () => {
    expect(pendingRootPrefixLength("all done.", `${WORKSPACE}/`)).toBe(0);
  });

  test("holds back the bare root, since the next character decides", () => {
    // `root` alone becomes "."; `root/` is dropped. Emitting early produced
    // "./a.ts" for what should have been "a.ts".
    expect(pendingRootPrefixLength(WORKSPACE, `${WORKSPACE}/`)).toBe(
      WORKSPACE.length,
    );
  });
});

describe("streamed text", () => {
  function streamDeltas(deltas: string[]): string {
    const mapper = new ClaudeUIStreamMapper({ workspaceRoot: WORKSPACE });
    let out = "";
    const collect = (chunks: ReturnType<ClaudeUIStreamMapper["map"]>) => {
      for (const chunk of chunks) {
        if (chunk.type === "text-delta") {
          out += chunk.delta;
        }
      }
    };

    collect(
      mapper.map({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text" },
        },
      } as never),
    );
    for (const text of deltas) {
      collect(
        mapper.map({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text },
          },
        } as never),
      );
    }
    collect(
      mapper.map({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      } as never),
    );
    return out;
  }

  test("rewrites a path split across two deltas", () => {
    // Regression: the delta boundary fell inside the path, so the per-delta
    // substitution missed it and the host path reached the UI.
    const [head, tail] = [
      `pwd returned ${WORKSPACE.slice(0, 30)}`,
      `${WORKSPACE.slice(30)} ok`,
    ];

    expect(streamDeltas([head, tail])).toBe("pwd returned . ok");
  });

  test("rewrites a path split one character at a time", () => {
    const text = `at ${WORKSPACE}/a.ts done`;

    expect(streamDeltas(text.split(""))).toBe("at a.ts done");
  });

  test("passes ordinary text through unchanged", () => {
    expect(streamDeltas(["Created ", "a.ts", " fine."])).toBe(
      "Created a.ts fine.",
    );
  });

  test("does not lose a tail that never becomes a path", () => {
    // The withheld span has to be flushed when the block closes.
    const text = "ends with /Users/ali";

    expect(streamDeltas([text])).toBe(text);
  });
});

describe("tool output size", () => {
  test("truncates a result too large to hold in memory", () => {
    // Regression: `npm install` on a fresh scaffold produced results large
    // enough that serialising the accumulated message exhausted the heap and
    // killed the server mid-stream, losing the reply.
    const huge = "x".repeat(200_000);
    const out = normalizeToolInput({ command: "npm install" }) as object;
    expect(out).toBeDefined();

    const mapper = new ClaudeUIStreamMapper({ workspaceRoot: WORKSPACE });
    const chunks = mapper.map({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: huge }],
      },
    } as never);

    const result = chunks.find((c) => c.type === "tool-output-available") as
      | { output: string }
      | undefined;
    expect(result).toBeDefined();
    expect(result?.output.length).toBeLessThan(huge.length);
    expect(result?.output).toContain("truncated");
  });

  test("leaves a normal-sized result untouched", () => {
    const mapper = new ClaudeUIStreamMapper({ workspaceRoot: WORKSPACE });
    const chunks = mapper.map({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
    } as never);

    const result = chunks.find((c) => c.type === "tool-output-available") as
      | { output: string }
      | undefined;
    expect(result?.output).toBe("ok");
  });

  test("still relativizes paths inside a truncated result", () => {
    const mapper = new ClaudeUIStreamMapper({ workspaceRoot: WORKSPACE });
    const chunks = mapper.map({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: `wrote ${WORKSPACE}/a.ts`,
          },
        ],
      },
    } as never);

    const result = chunks.find((c) => c.type === "tool-output-available") as
      | { output: string }
      | undefined;
    expect(result?.output).toBe("wrote a.ts");
  });
});
