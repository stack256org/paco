import { describe, expect, test } from "bun:test";
import {
  reconcileServerSessions,
  type SessionsSnapshot,
  sessionsSnapshotsEqual,
} from "./sessions-snapshot";
import type { SessionWithUnread } from "./use-sessions";

function createSession(
  id: string,
  overrides?: Partial<SessionWithUnread>,
): SessionWithUnread {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id,
    title: `Workspace ${id}`,
    status: "running",
    repoOwner: "paco",
    repoName: "paco",
    branch: `chat/${id}`,
    linesAdded: 0,
    linesRemoved: 0,
    prNumber: null,
    prStatus: null,
    prChecks: null,
    createdAt: now,
    hasUnread: false,
    hasStreaming: false,
    latestChatId: null,
    lastActivityAt: now,
    ...overrides,
  };
}

const noPending: ReadonlySet<string> = new Set<string>();

describe("reconcileServerSessions", () => {
  test("takes the server snapshot when the cache is empty", () => {
    const server: SessionsSnapshot = {
      sessions: [createSession("a")],
      archivedCount: 2,
    };

    expect(
      reconcileServerSessions({
        server,
        cached: undefined,
        pendingSessionIds: noPending,
      }),
    ).toBe(server);
  });

  /**
   * The regression: a cache holding the pre-restore reading used to outrank a
   * server render made after the restore, so the switcher kept the old list and
   * the old `Archived N` badge until a full page load.
   */
  test("fresher server data beats a stale cache", () => {
    const restored = createSession("a", { status: "running" });
    const cached: SessionsSnapshot = {
      sessions: [createSession("b")],
      archivedCount: 3,
    };
    const server: SessionsSnapshot = {
      sessions: [restored, createSession("b")],
      archivedCount: 2,
    };

    const result = reconcileServerSessions({
      server,
      cached,
      pendingSessionIds: noPending,
    });

    expect(result.sessions.map((session) => session.id)).toEqual(["a", "b"]);
    expect(result.archivedCount).toBe(2);
  });

  test("a stale cache shaped by another endpoint does not survive", () => {
    // The home page fills the same cache key from `/api/sessions` (every
    // status, no archived count); the sessions layout renders active only.
    const cached: SessionsSnapshot = {
      sessions: [
        createSession("a"),
        createSession("b", { status: "archived" }),
      ],
      archivedCount: undefined,
    };
    const server: SessionsSnapshot = {
      sessions: [createSession("a")],
      archivedCount: 1,
    };

    const result = reconcileServerSessions({
      server,
      cached,
      pendingSessionIds: noPending,
    });

    expect(result.sessions.map((session) => session.id)).toEqual(["a"]);
    expect(result.archivedCount).toBe(1);
  });

  test("keeps an optimistic rename that the server has not caught up with", () => {
    const cached: SessionsSnapshot = {
      sessions: [createSession("a", { title: "Renamed" }), createSession("b")],
      archivedCount: 1,
    };
    const server: SessionsSnapshot = {
      sessions: [
        createSession("a", { title: "Old name" }),
        createSession("b", { linesAdded: 42 }),
      ],
      archivedCount: 1,
    };

    const result = reconcileServerSessions({
      server,
      cached,
      pendingSessionIds: new Set(["a"]),
    });

    expect(result.sessions[0]?.title).toBe("Renamed");
    // Everything not pending still takes the fresher server row.
    expect(result.sessions[1]?.linesAdded).toBe(42);
  });

  test("does not resurrect a workspace being archived", () => {
    const cached: SessionsSnapshot = {
      sessions: [createSession("b")],
      archivedCount: 2,
    };
    const server: SessionsSnapshot = {
      sessions: [createSession("a"), createSession("b")],
      archivedCount: 1,
    };

    const result = reconcileServerSessions({
      server,
      cached,
      pendingSessionIds: new Set(["a"]),
    });

    expect(result.sessions.map((session) => session.id)).toEqual(["b"]);
    // The optimistic count matches the rows that are actually on screen.
    expect(result.archivedCount).toBe(2);
  });

  test("keeps a pending workspace the server has not listed yet", () => {
    const cached: SessionsSnapshot = {
      sessions: [createSession("new"), createSession("a")],
      archivedCount: 0,
    };
    const server: SessionsSnapshot = {
      sessions: [createSession("a")],
      archivedCount: 1,
    };

    const result = reconcileServerSessions({
      server,
      cached,
      pendingSessionIds: new Set(["new"]),
    });

    expect(result.sessions.map((session) => session.id)).toEqual(["new", "a"]);
  });

  test("falls back to the server count when the cache has none", () => {
    const cached: SessionsSnapshot = { sessions: [createSession("a")] };
    const server: SessionsSnapshot = {
      sessions: [createSession("a")],
      archivedCount: 4,
    };

    const result = reconcileServerSessions({
      server,
      cached,
      pendingSessionIds: new Set(["a"]),
    });

    expect(result.archivedCount).toBe(4);
  });
});

describe("sessionsSnapshotsEqual", () => {
  test("two renders of the same data are equal", () => {
    const a: SessionsSnapshot = {
      sessions: [createSession("a"), createSession("b")],
      archivedCount: 1,
    };
    const b: SessionsSnapshot = {
      sessions: [createSession("a"), createSession("b")],
      archivedCount: 1,
    };

    expect(sessionsSnapshotsEqual(a, b)).toBe(true);
  });

  test("a changed archived count is not equal", () => {
    const a: SessionsSnapshot = { sessions: [], archivedCount: 1 };
    const b: SessionsSnapshot = { sessions: [], archivedCount: 0 };

    expect(sessionsSnapshotsEqual(a, b)).toBe(false);
  });

  test("a changed row is not equal", () => {
    const a: SessionsSnapshot = { sessions: [createSession("a")] };
    const b: SessionsSnapshot = {
      sessions: [createSession("a", { status: "archived" })],
    };

    expect(sessionsSnapshotsEqual(a, b)).toBe(false);
  });

  test("a changed order is not equal", () => {
    const a: SessionsSnapshot = {
      sessions: [createSession("a"), createSession("b")],
    };
    const b: SessionsSnapshot = {
      sessions: [createSession("b"), createSession("a")],
    };

    expect(sessionsSnapshotsEqual(a, b)).toBe(false);
  });

  test("a date serialised as a string still matches its Date", () => {
    const a: SessionsSnapshot = { sessions: [createSession("a")] };
    const serialised = "2026-01-01T00:00:00.000Z" as unknown as Date;
    const b: SessionsSnapshot = {
      sessions: [
        createSession("a", {
          createdAt: serialised,
          lastActivityAt: serialised,
        }),
      ],
    };

    expect(sessionsSnapshotsEqual(a, b)).toBe(true);
  });

  test("undefined only equals undefined", () => {
    expect(sessionsSnapshotsEqual(undefined, undefined)).toBe(true);
    expect(sessionsSnapshotsEqual(undefined, { sessions: [] })).toBe(false);
    expect(sessionsSnapshotsEqual({ sessions: [] }, undefined)).toBe(false);
  });
});
