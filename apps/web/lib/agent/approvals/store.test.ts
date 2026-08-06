import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const { listPendingApprovals, requestApproval, resolveApproval } =
  await import("./store");

function ask(chatId: string, detail = "rm -rf dist") {
  return requestApproval({
    chatId,
    toolName: "Bash",
    reason: "deletes files recursively",
    detail,
  });
}

describe("requestApproval", () => {
  test("blocks until the user answers, then reports the outcome", async () => {
    const pending = ask("chat-1");

    const [request] = listPendingApprovals("chat-1");
    expect(request?.toolName).toBe("Bash");
    expect(request?.detail).toBe("rm -rf dist");

    expect(resolveApproval(request?.id ?? "", "chat-1", "allow")).toBe(true);
    expect(await pending).toBe("allow");
  });

  test("stops listing a request once it is answered", async () => {
    const pending = ask("chat-2");
    const [request] = listPendingApprovals("chat-2");

    resolveApproval(request?.id ?? "", "chat-2", "deny");
    await pending;

    expect(listPendingApprovals("chat-2")).toHaveLength(0);
  });

  test("denies when the turn is aborted", async () => {
    // The hook process must not be left waiting on a decision about work that
    // is no longer happening.
    const controller = new AbortController();
    const pending = requestApproval({
      chatId: "chat-3",
      toolName: "Bash",
      reason: "r",
      detail: "d",
      signal: controller.signal,
    });

    controller.abort();

    expect(await pending).toBe("deny");
    expect(listPendingApprovals("chat-3")).toHaveLength(0);
  });

  test("keeps each chat's requests to itself", async () => {
    const a = ask("chat-a");
    const b = ask("chat-b");

    expect(listPendingApprovals("chat-a")).toHaveLength(1);
    expect(listPendingApprovals("chat-b")).toHaveLength(1);

    const [ra] = listPendingApprovals("chat-a");
    // A request id is a capability; another chat must not be able to spend it.
    expect(resolveApproval(ra?.id ?? "", "chat-b", "allow")).toBe(false);

    resolveApproval(ra?.id ?? "", "chat-a", "allow");
    const [rb] = listPendingApprovals("chat-b");
    resolveApproval(rb?.id ?? "", "chat-b", "deny");

    expect(await a).toBe("allow");
    expect(await b).toBe("deny");
  });

  test("ignores a second answer to the same request", async () => {
    // A double click, or a decision that lands after a timeout.
    const pending = ask("chat-4");
    const [request] = listPendingApprovals("chat-4");

    expect(resolveApproval(request?.id ?? "", "chat-4", "allow")).toBe(true);
    expect(resolveApproval(request?.id ?? "", "chat-4", "deny")).toBe(false);

    expect(await pending).toBe("allow");
  });

  test("lists several requests oldest first", async () => {
    const first = ask("chat-5", "one");
    const second = ask("chat-5", "two");

    expect(listPendingApprovals("chat-5").map((r) => r.detail)).toEqual([
      "one",
      "two",
    ]);

    for (const request of listPendingApprovals("chat-5")) {
      resolveApproval(request.id, "chat-5", "deny");
    }
    await Promise.all([first, second]);
  });
});
