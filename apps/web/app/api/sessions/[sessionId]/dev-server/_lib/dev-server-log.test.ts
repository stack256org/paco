import { describe, expect, test } from "bun:test";
import {
  DEV_SERVER_LOG_MAX_CHARS,
  DEV_SERVER_LOG_TAIL_LINES,
  summarizeDevServerLog,
} from "./dev-server-log";

const ESCAPE = String.fromCharCode(27);

describe("summarizeDevServerLog", () => {
  test("nothing captured is null, not an empty block", () => {
    expect(summarizeDevServerLog(null)).toBeNull();
    expect(summarizeDevServerLog("")).toBeNull();
    expect(summarizeDevServerLog("\n \n\t\n")).toBeNull();
  });

  test("keeps the last lines, where the reason lives", () => {
    const raw = Array.from({ length: 60 }, (_, index) => `line ${index}`).join(
      "\n",
    );

    const summary = summarizeDevServerLog(raw);

    expect(summary?.split("\n")).toHaveLength(DEV_SERVER_LOG_TAIL_LINES);
    expect(summary).toContain("line 59");
    expect(summary).not.toContain("line 39\n");
  });

  test("strips the colours a dev server writes", () => {
    // Vite and Next both colour their output. Raw, these bytes reach the
    // browser as unreadable noise wrapped around the actual error.
    const raw = `${ESCAPE}[31mSyntaxError${ESCAPE}[0m: Unexpected token`;

    expect(summarizeDevServerLog(raw)).toBe("SyntaxError: Unexpected token");
  });

  test("strips window-title sequences too", () => {
    const raw = `${ESCAPE}]0;vite dev${String.fromCharCode(7)}ready in 300ms`;

    expect(summarizeDevServerLog(raw)).toBe("ready in 300ms");
  });

  test("carriage returns from progress bars become line breaks, not gibberish", () => {
    const summary = summarizeDevServerLog("installing…\rdone\nready");

    expect(summary).toBe("installing…\ndone\nready");
  });

  test("caps the payload, keeping the end", () => {
    const raw = Array.from({ length: 30 }, () => "x".repeat(300)).join("\n");

    const summary = summarizeDevServerLog(raw);

    expect(summary?.length).toBe(DEV_SERVER_LOG_MAX_CHARS);
    expect(raw.endsWith(summary ?? "")).toBe(true);
  });

  test("real crash output survives intact", () => {
    // Copied from a container run: a node dev server that logged a ready line
    // and then exited on an error.
    const raw = [
      "VITE v5.4.0  ready in 312 ms",
      "",
      "  ➜  Local:   http://localhost:5173/",
      "SyntaxError: Unexpected token in src/App.tsx:12",
      "",
    ].join("\n");

    expect(summarizeDevServerLog(raw)).toBe(
      [
        "VITE v5.4.0  ready in 312 ms",
        "  ➜  Local:   http://localhost:5173/",
        "SyntaxError: Unexpected token in src/App.tsx:12",
      ].join("\n"),
    );
  });
});
