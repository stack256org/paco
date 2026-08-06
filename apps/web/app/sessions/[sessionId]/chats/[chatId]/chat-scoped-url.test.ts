import { describe, expect, test } from "bun:test";
import { chatScopedUrl } from "./chat-scoped-url";

describe("chatScopedUrl", () => {
  test("scopes a session route to the chat", () => {
    expect(chatScopedUrl("/api/sessions/s1/diff/patch", "chat-1")).toBe(
      "/api/sessions/s1/diff/patch?chatId=chat-1",
    );
  });

  test("escapes the chat id", () => {
    expect(chatScopedUrl("/api/sessions/s1/x", "a b&c")).toBe(
      "/api/sessions/s1/x?chatId=a%20b%26c",
    );
  });

  test("appends to an existing query string", () => {
    expect(chatScopedUrl("/api/sessions/s1/x?scope=all", "chat-1")).toBe(
      "/api/sessions/s1/x?scope=all&chatId=chat-1",
    );
  });

  test("falls back to the session-wide route outside a chat", () => {
    expect(chatScopedUrl("/api/sessions/s1/x", "")).toBe("/api/sessions/s1/x");
  });
});

/**
 * Extract the argument text of the first `name(` call in `source`.
 *
 * Balanced-paren scan rather than a regex, because these calls span lines and
 * contain nested calls and object literals.
 */
function callArguments(source: string, name: string): string {
  const start = source.indexOf(`${name}(`);
  if (start === -1) {
    throw new Error(`No call to ${name} found`);
  }

  let depth = 0;
  for (let i = start + name.length; i < source.length; i++) {
    const char = source[i];
    if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  throw new Error(`Unbalanced call to ${name}`);
}

function readPanel(file: string): Promise<string> {
  return Bun.file(`${import.meta.dir}/${file}`).text();
}

/*
 * AGENTS.md: "Anything chat-scoped must resolve its directory with
 * `resolveWorkCwd`" — and it can only do that if the caller says which chat.
 *
 * These four calls all omitted it. The session repository is a valid repository
 * sitting on the default branch, so every one of them succeeded against the
 * wrong tree instead of failing: Discard ran `git reset --hard` and
 * `git clean -fd` in the session repo, destroying untracked files there,
 * discarding none of the chat's work, and reporting success. Nothing here is
 * observable from a unit test of the components, so the call sites are asserted
 * directly.
 */
describe("chat-scoped call sites", () => {
  test("Discard targets the chat's worktree", async () => {
    const source = await readPanel("git-panel.tsx");
    expect(callArguments(source, "discardChanges")).toContain("chatId");
  });

  test("Create branch targets the chat's worktree, from both panels", async () => {
    for (const file of [
      "inline-commit-panel.tsx",
      "inline-pr-create-panel.tsx",
    ]) {
      const source = await readPanel(file);
      expect(callArguments(source, "createBranch")).toContain("chatId");
    }
  });

  test("Download diff asks for the chat's patch", async () => {
    const source = await readPanel("diff-tab-view.tsx");
    expect(source).toContain("chatScopedUrl(");
    expect(source).toMatch(/diff\/patch`,\s*\n\s*chatId,/);
  });

  test("Generate commit message reads the chat's changes", async () => {
    const source = await readPanel("inline-commit-panel.tsx");
    expect(source).toContain("chatScopedUrl(");
    expect(source).toMatch(/generate-commit-message`,\s*\n\s*chatId,/);
  });
});
