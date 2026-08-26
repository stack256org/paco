import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// "server-only" throws outside a server component; the marker is not what is
// under test here.
mock.module("server-only", () => ({}));

let hostWorkspace = "";
mock.module("@/lib/agent/workspace-paths", () => ({
  hostWorkspaceFor: () => hostWorkspace,
}));

const { planAttachments } = await import("./attachment-prompt");
const { stageTurnAttachments } = await import("./attachment-staging");

const SANDBOX_STATE = {
  type: "docker" as const,
  sandboxName: "session_session-1",
  expiresAt: Date.now() + 60_000,
};

// `SandboxState` is a wide union; this suite only needs `hostWorkspaceFor`
// to be reachable, and that is mocked above.
const sandboxState = SANDBOX_STATE as unknown as Parameters<
  typeof stageTurnAttachments
>[0]["sandboxState"];

const OVERSIZED = "log line\n".repeat(4000);

beforeEach(() => {
  hostWorkspace = mkdtempSync(join(tmpdir(), "paco-staging-test-"));
});

describe("stageTurnAttachments", () => {
  test("writes an oversized text attachment whole and returns its path", async () => {
    const plan = planAttachments([
      { kind: "text", filename: "huge.log", content: OVERSIZED },
    ]);

    const staged = await stageTurnAttachments({
      sandboxState,
      chatId: "chat-1",
      userMessageId: "user-1",
      plan,
    });

    const written = staged.get(0);
    expect(written).toBeDefined();
    expect(await readFile(written?.path ?? "", "utf8")).toBe(OVERSIZED);
    expect(written?.byteSize).toBe(Buffer.byteLength(OVERSIZED, "utf8"));
  });

  test("stages beside the repository, never inside a worktree", async () => {
    // The chat's worktree is committed with `git add -A` after a turn. A
    // staging directory inside it would put the user's pasted log in their
    // history and their diff.
    const plan = planAttachments([
      { kind: "text", filename: "huge.log", content: OVERSIZED },
    ]);
    const staged = await stageTurnAttachments({
      sandboxState,
      chatId: "chat-1",
      userMessageId: "user-1",
      plan,
    });

    expect(staged.get(0)?.path).toBe(
      join(hostWorkspace, ".paco-attachments", "chat-1", "user-1", "huge.log"),
    );
  });

  test("decodes a binary attachment back to its exact bytes", async () => {
    // A 1x1 transparent PNG. `Read` handles images natively, so a path is
    // all the agent needs to see one.
    const base64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const plan = planAttachments([
      { kind: "binary", filename: "shot.png", mediaType: "image/png", base64 },
    ]);

    const staged = await stageTurnAttachments({
      sandboxState,
      chatId: "chat-1",
      userMessageId: "user-1",
      plan,
    });

    const bytes = await readFile(staged.get(0)?.path ?? "");
    expect(bytes.toString("base64")).toBe(base64);
  });

  test("a traversal in the filename cannot escape the staging directory", async () => {
    const plan = planAttachments([
      {
        kind: "text",
        filename: "../../../escaped.log",
        content: OVERSIZED,
      },
    ]);

    const staged = await stageTurnAttachments({
      sandboxState,
      chatId: "chat-1",
      userMessageId: "user-1",
      plan,
    });

    expect(staged.get(0)?.path).toBe(
      join(
        hostWorkspace,
        ".paco-attachments",
        "chat-1",
        "user-1",
        "escaped.log",
      ),
    );
  });

  test("prunes earlier turns' attachments for the same chat", async () => {
    // Only the newest user message's attachments are ever named in a
    // prompt, so anything older is dead weight that would otherwise
    // accumulate for the life of the workspace.
    const chatDir = join(hostWorkspace, ".paco-attachments", "chat-1");
    await mkdir(join(chatDir, "user-0"), { recursive: true });
    await writeFile(join(chatDir, "user-0", "old.log"), "stale");

    await stageTurnAttachments({
      sandboxState,
      chatId: "chat-1",
      userMessageId: "user-1",
      plan: planAttachments([
        { kind: "text", filename: "huge.log", content: OVERSIZED },
      ]),
    });

    expect((await readdir(chatDir)).sort()).toEqual(["user-1"]);
  });

  test("leaves another chat's attachments alone", async () => {
    const otherChatDir = join(hostWorkspace, ".paco-attachments", "chat-2");
    await mkdir(join(otherChatDir, "user-9"), { recursive: true });
    await writeFile(join(otherChatDir, "user-9", "theirs.log"), "theirs");

    await stageTurnAttachments({
      sandboxState,
      chatId: "chat-1",
      userMessageId: "user-1",
      plan: planAttachments([
        { kind: "text", filename: "huge.log", content: OVERSIZED },
      ]),
    });

    expect(await readdir(otherChatDir)).toEqual(["user-9"]);
  });

  test("writes nothing when every attachment is small enough to inline", async () => {
    const staged = await stageTurnAttachments({
      sandboxState,
      chatId: "chat-1",
      userMessageId: "user-1",
      plan: planAttachments([
        { kind: "text", filename: "notes.txt", content: "short" },
      ]),
    });

    expect(staged.size).toBe(0);
    await expect(
      readdir(join(hostWorkspace, ".paco-attachments")),
    ).rejects.toThrow();
  });

  test("degrades to an empty result rather than failing the turn", async () => {
    // A turn must not die because a log could not be saved. The prompt
    // renderer turns a missing entry into an excerpt plus a statement that
    // the rest is unavailable.
    hostWorkspace = "/proc/paco-cannot-write-here";

    const staged = await stageTurnAttachments({
      sandboxState,
      chatId: "chat-1",
      userMessageId: "user-1",
      plan: planAttachments([
        { kind: "text", filename: "huge.log", content: OVERSIZED },
      ]),
    });

    expect(staged.size).toBe(0);
  });
});
