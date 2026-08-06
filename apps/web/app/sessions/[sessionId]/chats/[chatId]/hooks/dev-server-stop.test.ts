import { describe, expect, test } from "bun:test";
import { readDevServerStopBody, requestDevServerStop } from "./dev-server-stop";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("requestDevServerStop", () => {
  test("reports failure when the server answers 200 with stopped:false", async () => {
    /*
     * The DELETE route returns HTTP 200 and `{ stopped: false }` when the
     * process is still listening after SIGKILL — it reports the truth rather
     * than a comforting status code. The caller checked only `response.ok` and
     * went idle, so a dev server that survived the kill vanished from the panel
     * while it still held the port, and the next Start collided with it.
     */
    const result = await requestDevServerStop({
      sessionId: "s1",
      chatId: "c1",
      fetchImpl: async () =>
        jsonResponse(200, {
          stopped: false,
          packagePath: "apps/web",
          port: 3000,
        }),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message.length > 0).toBe(true);
  });

  test("reports success when the process really is gone", async () => {
    const result = await requestDevServerStop({
      sessionId: "s1",
      chatId: "c1",
      fetchImpl: async () =>
        jsonResponse(200, {
          stopped: true,
          packagePath: "apps/web",
          port: 3000,
        }),
    });

    expect(result).toEqual({ ok: true });
  });

  test("surfaces the server's message on an error status", async () => {
    const result = await requestDevServerStop({
      sessionId: "s1",
      chatId: "c1",
      fetchImpl: async () =>
        jsonResponse(409, { error: "Workspace is asleep" }),
    });

    expect(result).toEqual({ ok: false, message: "Workspace is asleep" });
  });

  test("scopes the request to the chat's worktree", async () => {
    const requested: string[] = [];

    await requestDevServerStop({
      sessionId: "s1",
      chatId: "chat 1",
      fetchImpl: async (input, init) => {
        requested.push(input);
        expect(init?.method).toBe("DELETE");
        return jsonResponse(200, { stopped: true });
      },
    });

    expect(requested).toEqual(["/api/sessions/s1/dev-server?chatId=chat%201"]);
  });
});

describe("readDevServerStopBody", () => {
  test("treats a missing `stopped` as success", async () => {
    // An older server, or an error body that carried its own message: neither
    // is evidence that something is still running.
    expect(readDevServerStopBody({ packagePath: "apps/web" })).toEqual({
      ok: true,
    });
    expect(readDevServerStopBody(null)).toEqual({ ok: true });
  });
});
