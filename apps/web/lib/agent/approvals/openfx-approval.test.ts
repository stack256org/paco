import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionRequestParams } from "@paco/openfx-backend";

// Both `openfx-approval.ts` and `@paco/claude-code`'s approval policy import
// "server-only"; the marker throws outside a server component.
mock.module("server-only", () => ({}));

const requestApprovalCalls: Array<{
  chatId: string;
  toolName: string;
  reason: string;
  detail: string;
}> = [];
let nextOutcome: "allow" | "deny" = "deny";

mock.module("./store", () => ({
  requestApproval: async (params: {
    chatId: string;
    toolName: string;
    reason: string;
    detail: string;
  }) => {
    requestApprovalCalls.push(params);
    return nextOutcome;
  },
}));

const modulePromise = import("./openfx-approval");

const worktree = mkdtempSync(join(tmpdir(), "paco-openfx-approval-"));

function makeRequest(
  overrides: Partial<PermissionRequestParams["toolCall"]> & {
    options?: PermissionRequestParams["options"];
  } = {},
): PermissionRequestParams {
  const { options, ...toolCallOverrides } = overrides;
  return {
    sessionId: "session-1",
    toolCall: {
      toolCallId: "call-1",
      title: "Read a file",
      kind: "read",
      status: "pending",
      rawInput: {},
      ...toolCallOverrides,
    },
    options: options ?? [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ],
  };
}

describe("createOpenFxApprovalHandler", () => {
  test("a read-only kind is auto-allowed without asking the user", async () => {
    const { createOpenFxApprovalHandler } = await modulePromise;
    const handler = createOpenFxApprovalHandler({
      chatId: "chat-1",
      worktree,
    });
    requestApprovalCalls.length = 0;

    const decision = await handler(makeRequest({ kind: "read" }));

    expect(decision).toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
    expect(requestApprovalCalls).toHaveLength(0);
  });

  test("an edit inside the worktree is auto-allowed", async () => {
    const { createOpenFxApprovalHandler } = await modulePromise;
    const handler = createOpenFxApprovalHandler({
      chatId: "chat-1",
      worktree,
    });
    requestApprovalCalls.length = 0;

    const decision = await handler(
      makeRequest({
        kind: "edit",
        rawInput: { file_path: join(worktree, "notes.md") },
      }),
    );

    expect(decision).toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
    expect(requestApprovalCalls).toHaveLength(0);
  });

  test("an edit outside the worktree asks the user, and allow selects allow_once", async () => {
    const { createOpenFxApprovalHandler } = await modulePromise;
    const handler = createOpenFxApprovalHandler({
      chatId: "chat-42",
      worktree,
    });
    requestApprovalCalls.length = 0;
    nextOutcome = "allow";

    const decision = await handler(
      makeRequest({
        kind: "edit",
        title: "Edit /etc/passwd",
        rawInput: { file_path: "/etc/passwd" },
      }),
    );

    expect(requestApprovalCalls).toHaveLength(1);
    expect(requestApprovalCalls[0]?.chatId).toBe("chat-42");
    expect(requestApprovalCalls[0]?.reason).toContain("outside");
    expect(decision).toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
  });

  test("a denied outcome selects reject_once", async () => {
    const { createOpenFxApprovalHandler } = await modulePromise;
    const handler = createOpenFxApprovalHandler({
      chatId: "chat-42",
      worktree,
    });
    requestApprovalCalls.length = 0;
    nextOutcome = "deny";

    const decision = await handler(
      makeRequest({
        kind: "edit",
        rawInput: { file_path: "/etc/passwd" },
      }),
    );

    expect(decision).toEqual({
      outcome: { outcome: "selected", optionId: "reject_once" },
    });
  });

  test("an unrecognised kind is treated as unknown and always asks", async () => {
    const { createOpenFxApprovalHandler } = await modulePromise;
    const handler = createOpenFxApprovalHandler({
      chatId: "chat-1",
      worktree,
    });
    requestApprovalCalls.length = 0;
    nextOutcome = "deny";

    const decision = await handler(makeRequest({ kind: "other" }));

    expect(requestApprovalCalls).toHaveLength(1);
    expect(decision).toEqual({
      outcome: { outcome: "selected", optionId: "reject_once" },
    });
  });

  test("falls back to cancelled when no matching option was offered", async () => {
    const { createOpenFxApprovalHandler } = await modulePromise;
    const handler = createOpenFxApprovalHandler({
      chatId: "chat-1",
      worktree,
    });
    nextOutcome = "deny";

    const decision = await handler(makeRequest({ kind: "other", options: [] }));

    expect(decision).toEqual({ outcome: { outcome: "cancelled" } });
  });
});
