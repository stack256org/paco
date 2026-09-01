import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

mock.module("next/server", () => ({
  after: (task: () => Promise<unknown>) => {
    void task;
  },
}));

type SessionRow = {
  id: string;
  userId: string;
  title: string;
  status: string;
  sandboxState: unknown;
};

const VICTIM_SANDBOX = { type: "docker", sandboxName: "session_victim" };

let sessionRow: SessionRow = {
  id: "session-1",
  userId: "user-1",
  title: "Original",
  status: "running",
  sandboxState: { type: "docker", sandboxName: "session_1" },
};

const updateCalls: Array<Record<string, unknown>> = [];
const archiveCalls: Array<Record<string, unknown>> = [];

mock.module("@/lib/db/sessions", () => ({
  getSessionById: async () => sessionRow,
  deleteSession: async () => undefined,
  updateSession: async (_sessionId: string, data: Record<string, unknown>) => {
    updateCalls.push(data);
    return { ...sessionRow, ...data };
  },
}));

mock.module("@/lib/sandbox/archive-session", () => ({
  archiveSession: async (
    _sessionId: string,
    options: { update?: Record<string, unknown> },
  ) => {
    archiveCalls.push(options.update ?? {});
    return {
      session: { ...sessionRow, ...options.update },
      archiveTriggered: true,
    };
  },
}));

/**
 * Whether the archive's background container stop is still in flight.
 *
 * Mutable because the unarchive guard is the only thing standing between a
 * restore and a container that is halfway through stopping, and both answers
 * have to be exercised.
 */
let containerStillRunning = false;

mock.module("@/lib/sandbox/utils", () => ({
  hasRuntimeSandboxState: () => containerStillRunning,
}));

const deleteCalls: Array<{ sessionId: string; force: boolean }> = [];
let deleteBlockedByUnsavedWork = false;

mock.module("@/lib/reaping/delete-session", () => ({
  deleteSessionAndResources: async (
    session: { id: string },
    options: { force?: boolean },
  ) => {
    deleteCalls.push({
      sessionId: session.id,
      force: options.force ?? false,
    });
    if (deleteBlockedByUnsavedWork && !options.force) {
      return {
        ok: false,
        blockedBy: {
          uncommittedFiles: 3,
          unpushedCommits: 2,
          hasRemote: false,
          trackedFiles: 40,
        },
        removedContainers: [],
        removedWorkspaces: [],
        freedBytes: 0,
        warnings: [],
      };
    }
    return {
      ok: true,
      removedContainers: ["paco-sbx-session_session-1"],
      removedWorkspaces: ["/home/u/.paco/workspaces/session_session-1"],
      freedBytes: 1024,
      warnings: [],
    };
  },
}));

const { DELETE, PATCH } = await import("./route");

function patch(body: unknown) {
  return PATCH(
    new Request("http://localhost/api/sessions/session-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ sessionId: "session-1" }) },
  );
}

describe("PATCH /api/sessions/[sessionId]", () => {
  beforeEach(() => {
    updateCalls.length = 0;
    archiveCalls.length = 0;
    containerStillRunning = false;
    sessionRow = {
      id: "session-1",
      userId: "user-1",
      title: "Original",
      status: "running",
      sandboxState: { type: "docker", sandboxName: "session_1" },
    };
  });

  test("renames a session, which is what the client actually sends", async () => {
    const response = await patch({ title: "Renamed" });

    expect(response.status).toBe(200);
    expect(updateCalls).toEqual([{ title: "Renamed" }]);
  });

  test("refuses to hand the session to another user", async () => {
    // The body was cast, not parsed, and then spread into `.set()`. Drizzle
    // writes every key naming a real column, so this one line moved someone
    // else's ownership of the row.
    const response = await patch({ userId: "user-2" });

    expect(response.status).toBe(400);
    expect(updateCalls).toEqual([]);
  });

  test("refuses to repoint the session at another user's workspace", async () => {
    // `sandboxState` decides which directory /files, /diff and /files/content
    // read. Those guards check that you own *your* row — which you still do
    // after this write, which is exactly why it worked.
    const response = await patch({ sandboxState: VICTIM_SANDBOX });

    expect(response.status).toBe(400);
    expect(updateCalls).toEqual([]);
  });

  test("rejects any key the endpoint does not support", async () => {
    for (const body of [
      { title: "Renamed", userId: "user-2" },
      { linesAdded: 9999 },
      { prNumber: 42 },
      { lifecycleState: "archived" },
      { createdAt: "1999-01-01T00:00:00.000Z" },
      { id: "session-2" },
    ]) {
      const response = await patch(body);
      expect(response.status).toBe(400);
    }

    expect(updateCalls).toEqual([]);
  });

  test("rejects a body that is not an object", async () => {
    expect((await patch("title")).status).toBe(400);
    expect((await patch(null)).status).toBe(400);

    const malformed = await PATCH(
      new Request("http://localhost/api/sessions/session-1", {
        method: "PATCH",
        body: "{not json",
      }),
      { params: Promise.resolve({ sessionId: "session-1" }) },
    );
    expect(malformed.status).toBe(400);
    expect(updateCalls).toEqual([]);
  });

  test("still archives and unarchives", async () => {
    await patch({ status: "archived" });
    expect(archiveCalls).toEqual([{ status: "archived" }]);

    sessionRow = { ...sessionRow, status: "archived" };
    await patch({ status: "running" });
    expect(updateCalls.at(-1)).toEqual({
      status: "running",
      lifecycleState: null,
      lifecycleError: null,
    });
  });

  test("unarchiving starts no container of its own", async () => {
    // Restoring is a status change and nothing more. The workspace directory
    // survives archiving and the sandbox keeps its name, so whatever needs a
    // container next wakes one — paying for a Docker start here would charge
    // every restore for a sandbox the user may never ask to run.
    sessionRow = { ...sessionRow, status: "archived" };

    await patch({ status: "running" });

    expect(updateCalls.at(-1)).not.toHaveProperty("sandboxState");
  });

  test("refuses to unarchive while the container is still stopping", async () => {
    // Archiving stops the container after the response, so there is a window
    // where the row says archived and the container is still up. Restoring into
    // it would race the stop.
    sessionRow = { ...sessionRow, status: "archived" };
    containerStillRunning = true;

    const response = await patch({ status: "running" });

    expect(response.status).toBe(409);
    expect(updateCalls).toEqual([]);
    // The message is shown to the user verbatim, so it has to say what to do.
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Wait a few seconds");
  });
});

function del(query = "") {
  return DELETE(
    new Request(`http://localhost/api/sessions/session-1${query}`, {
      method: "DELETE",
    }),
    { params: Promise.resolve({ sessionId: "session-1" }) },
  );
}

describe("DELETE /api/sessions/[sessionId]", () => {
  beforeEach(() => {
    deleteCalls.length = 0;
    deleteBlockedByUnsavedWork = false;
    sessionRow = {
      id: "session-1",
      userId: "user-1",
      title: "Original",
      status: "running",
      sandboxState: { type: "docker", sandboxName: "session_1" },
    };
  });

  test("reaps the container and the workspace, not just the row", async () => {
    // Deleting only the row is what produced the orphans: the container kept
    // running and the worktree kept its disk, unreachable from the product.
    const response = await del();

    expect(response.status).toBe(200);
    expect(deleteCalls).toEqual([{ sessionId: "session-1", force: false }]);

    const body = (await response.json()) as {
      removedContainers: string[];
      freedBytes: number;
    };
    expect(body.removedContainers).toEqual(["paco-sbx-session_session-1"]);
    expect(body.freedBytes).toBe(1024);
  });

  test("stops rather than taking unpushed commits with it", async () => {
    deleteBlockedByUnsavedWork = true;

    const response = await del();

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: string;
      unsavedWork: { unpushedCommits: number };
    };
    expect(body.error).toContain("isn't saved anywhere else");
    expect(body.unsavedWork.unpushedCommits).toBe(2);
  });

  test("force=1 is the caller saying the person was shown and agreed", async () => {
    deleteBlockedByUnsavedWork = true;

    const response = await del("?force=1");

    expect(response.status).toBe(200);
    expect(deleteCalls).toEqual([{ sessionId: "session-1", force: true }]);
  });
});
