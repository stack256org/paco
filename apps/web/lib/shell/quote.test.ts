import { describe, expect, test } from "bun:test";
import { shellQuote } from "./quote";

/**
 * The quoted value is fed back through a real `bash -lc`, because the only
 * question that matters is what bash does with it — not what the string looks
 * like.
 */
async function bashEcho(value: string): Promise<string> {
  const proc = Bun.spawn(["bash", "-lc", `printf '%s' ${shellQuote(value)}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return stdout;
}

describe("shellQuote", () => {
  test("hands bash the exact string, expansions and all", async () => {
    // Regression: commit messages were interpolated with `JSON.stringify`, so
    // bash ran the backticks — ``fix: use `printf hi` here`` committed as
    // "fix: use hi here".
    for (const value of [
      "fix: use `printf hi` here",
      "fix: $(printf pwned)",
      // Written in two pieces so the literal itself contains no `${`.
      `fix: $HOME and $${"{PATH}"}`,
      "fix: a; printf pwned",
      'fix: "quoted" and \\backslashed\\',
      "fix: it's fine",
      "fix: '; printf pwned; '",
    ]) {
      expect(await bashEcho(value)).toBe(value);
    }
  });

  test("keeps a multi-line body on its own lines", async () => {
    // `JSON.stringify` encoded the newline as the two characters `\` and `n`,
    // so every commit body arrived flattened onto the subject line.
    const message = "fix: something\n\nBody line one\nBody line two";

    expect(await bashEcho(message)).toBe(message);
    expect(shellQuote(message)).toContain("\n");
    expect(shellQuote(message)).not.toContain("\\n");
  });

  test("closes, escapes and reopens an embedded single quote", async () => {
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`);
  });
});
