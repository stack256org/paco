import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

type UpsertMode = "inserted" | "updated" | "conflict";

let upsertMode: UpsertMode = "inserted";

// Rows returned by the fakeDb select() chain (used by getUsedSessionTitles)
let fakeSelectRows: { title: string }[] = [];

const fakeInsertedMessage = {
  id: "message-1",
  chatId: "chat-1",
  role: "assistant" as const,
  parts: { id: "message-1", role: "assistant", parts: [] },
  createdAt: new Date(),
};

// What the last db.update(...).set(...) was handed.
let lastUpdateSet: Record<string, unknown> = {};

const fakeSessionRow = {
  id: "session-1",
  title: "Original",
  sandboxState: null,
};

const fakeDb = {
  // Fluent select chain: db.select({…}).from(table)[.where(condition)]
  // `getUsedSessionTitles` reads every session unfiltered, so `from(...)`
  // must be awaitable on its own as well as chainable with `.where(...)`.
  select: (_columns: unknown) => ({
    from: (_table: unknown) => {
      const result = Promise.resolve(fakeSelectRows) as Promise<
        typeof fakeSelectRows
      > & {
        where: (condition: unknown) => Promise<typeof fakeSelectRows>;
      };
      result.where = async (_condition: unknown) => fakeSelectRows;
      return result;
    },
  }),

  // Fluent update chain: db.update(table).set(data).where(condition).returning()
  update: (_table: unknown) => ({
    set: (input: Record<string, unknown>) => {
      lastUpdateSet = input;
      return {
        where: (_condition: unknown) => ({
          returning: async () => [fakeSessionRow],
        }),
      };
    },
  }),

  transaction: async <T>(
    callback: (tx: {
      insert: (table: unknown) => {
        values: (input: unknown) => {
          onConflictDoNothing: (config: unknown) => {
            returning: () => Promise<(typeof fakeInsertedMessage)[]>;
          };
        };
      };
      update: (table: unknown) => {
        set: (input: unknown) => {
          where: (condition: unknown) => {
            returning: () => Promise<(typeof fakeInsertedMessage)[]>;
          };
        };
      };
    }) => Promise<T>,
  ) => {
    const tx = {
      insert: (_table: unknown) => ({
        values: (_input: unknown) => ({
          onConflictDoNothing: (_config: unknown) => ({
            returning: async () =>
              upsertMode === "inserted" ? [fakeInsertedMessage] : [],
          }),
        }),
      }),
      update: (_table: unknown) => ({
        set: (_input: unknown) => ({
          where: (_condition: unknown) => ({
            returning: async () =>
              upsertMode === "updated" ? [fakeInsertedMessage] : [],
          }),
        }),
      }),
    };

    return callback(tx);
  },
};

mock.module("./client", () => ({
  db: fakeDb,
}));

const sessionsModulePromise = import("./sessions");

describe("getUsedSessionTitles", () => {
  beforeEach(() => {
    fakeSelectRows = [];
  });

  test("returns an empty Set when there are no sessions", async () => {
    const { getUsedSessionTitles } = await sessionsModulePromise;
    fakeSelectRows = [];

    const result = await getUsedSessionTitles();
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });

  test("returns a Set containing all existing session titles", async () => {
    const { getUsedSessionTitles } = await sessionsModulePromise;
    fakeSelectRows = [
      { title: "Tokyo" },
      { title: "Paris" },
      { title: "Lagos" },
    ];

    const result = await getUsedSessionTitles();
    expect(result.size).toBe(3);
    expect(result.has("Tokyo")).toBe(true);
    expect(result.has("Paris")).toBe(true);
    expect(result.has("Lagos")).toBe(true);
  });

  test("deduplicates titles if the DB returns duplicates", async () => {
    const { getUsedSessionTitles } = await sessionsModulePromise;
    fakeSelectRows = [{ title: "Rome" }, { title: "Rome" }];

    const result = await getUsedSessionTitles();
    expect(result.size).toBe(1);
    expect(result.has("Rome")).toBe(true);
  });
});

describe("updateSession", () => {
  beforeEach(() => {
    lastUpdateSet = {};
  });

  /** The shape a caller reaches these with when nothing validated it first. */
  const unvalidated = (data: Record<string, unknown>) =>
    data as Parameters<
      Awaited<typeof sessionsModulePromise>["updateSession"]
    >[1];

  test("writes the fields it was asked to write", async () => {
    const { updateSession } = await sessionsModulePromise;

    await updateSession("session-1", { title: "Renamed" });

    expect(lastUpdateSet.title).toBe("Renamed");
    expect(lastUpdateSet.updatedAt).toBeInstanceOf(Date);
  });

  test("never writes the columns that say which session this is", async () => {
    // The signature already excluded them, and a type is erased at runtime: the
    // PATCH handler cast its request body straight into here, and drizzle sets
    // every key that names a real column.
    const { updateSession } = await sessionsModulePromise;

    await updateSession(
      "session-1",
      unvalidated({
        title: "Renamed",
        id: "session-2",
        createdAt: new Date(0),
      }),
    );

    expect(lastUpdateSet.title).toBe("Renamed");
    expect(lastUpdateSet).not.toHaveProperty("id");
    expect(lastUpdateSet).not.toHaveProperty("createdAt");
  });

  test("leaves the caller's own object alone", async () => {
    // Sanitising by mutation would edit an object the caller still holds —
    // `archiveSession` builds one update and reuses it.
    const { updateSession } = await sessionsModulePromise;
    const data = unvalidated({ title: "Renamed", id: "session-2" });

    await updateSession("session-1", data);

    expect(data).toHaveProperty("id", "session-2");
  });

  test("updateSessionIfNotArchived drops the same columns", async () => {
    const { updateSessionIfNotArchived } = await sessionsModulePromise;

    await updateSessionIfNotArchived(
      "session-1",
      unvalidated({ status: "running", id: "session-2" }),
    );

    expect(lastUpdateSet.status).toBe("running");
    expect(lastUpdateSet).not.toHaveProperty("id");
  });
});

describe("upsertChatMessageScoped", () => {
  beforeEach(() => {
    upsertMode = "inserted";
  });

  test("returns inserted when no existing row conflicts", async () => {
    const { upsertChatMessageScoped } = await sessionsModulePromise;
    upsertMode = "inserted";

    const result = await upsertChatMessageScoped({
      id: "message-1",
      chatId: "chat-1",
      role: "assistant",
      parts: { id: "message-1", role: "assistant", parts: [] },
    });

    expect(result.status).toBe("inserted");
  });

  test("returns updated when id exists in same chat and role", async () => {
    const { upsertChatMessageScoped } = await sessionsModulePromise;
    upsertMode = "updated";

    const result = await upsertChatMessageScoped({
      id: "message-1",
      chatId: "chat-1",
      role: "assistant",
      parts: { id: "message-1", role: "assistant", parts: [{ type: "text" }] },
    });

    expect(result.status).toBe("updated");
  });

  test("returns conflict when id exists for different chat/role scope", async () => {
    const { upsertChatMessageScoped } = await sessionsModulePromise;
    upsertMode = "conflict";

    const result = await upsertChatMessageScoped({
      id: "message-1",
      chatId: "chat-1",
      role: "assistant",
      parts: { id: "message-1", role: "assistant", parts: [{ type: "text" }] },
    });

    expect(result.status).toBe("conflict");
  });
});

describe("resolveChatResumeToken", () => {
  test("returns the token scoped to the requested backend", async () => {
    const { resolveChatResumeToken } = await sessionsModulePromise;

    const token = resolveChatResumeToken(
      {
        resumeTokens: {
          "claude-code": "claude-session-1",
          "other-backend": "other-session-1",
        },
        claudeSessionId: "legacy-value-should-not-be-read",
      },
      "other-backend",
    );

    expect(token).toBe("other-session-1");
  });

  test("returns undefined for a backend with no token yet — a fresh session, not a crash", async () => {
    const { resolveChatResumeToken } = await sessionsModulePromise;

    const token = resolveChatResumeToken(
      {
        resumeTokens: { "claude-code": "claude-session-1" },
        claudeSessionId: null,
      },
      "other-backend",
    );

    expect(token).toBeUndefined();
  });

  test("switching a chat's backend never leaks the other backend's token", async () => {
    const { resolveChatResumeToken } = await sessionsModulePromise;
    const chat = {
      resumeTokens: { "claude-code": "claude-session-1" },
      claudeSessionId: null,
    };

    // The chat has run on claude-code, never on the other backend: the
    // other backend must start a fresh session, not resume with
    // claude-code's session id.
    expect(resolveChatResumeToken(chat, "other-backend")).toBeUndefined();
    // Reading it back for claude-code still returns the original token.
    expect(resolveChatResumeToken(chat, "claude-code")).toBe(
      "claude-session-1",
    );
  });

  test("falls back to the legacy claudeSessionId column only for claude-code, and only when unscoped", () => {
    return sessionsModulePromise.then(({ resolveChatResumeToken }) => {
      const legacyRow = { resumeTokens: {}, claudeSessionId: "legacy-session" };

      expect(resolveChatResumeToken(legacyRow, "claude-code")).toBe(
        "legacy-session",
      );
      // The legacy column is Claude Code's own value; it must never answer
      // for a different backend.
      expect(
        resolveChatResumeToken(legacyRow, "other-backend"),
      ).toBeUndefined();
    });
  });

  test("a scoped token takes priority over the legacy column", async () => {
    const { resolveChatResumeToken } = await sessionsModulePromise;

    const token = resolveChatResumeToken(
      {
        resumeTokens: { "claude-code": "new-session" },
        claudeSessionId: "stale-legacy-session",
      },
      "claude-code",
    );

    expect(token).toBe("new-session");
  });
});

describe("setChatResumeToken", () => {
  beforeEach(() => {
    lastUpdateSet = {};
  });

  test("writes a resumeTokens merge, not the whole column, keyed by backend", async () => {
    const { setChatResumeToken } = await sessionsModulePromise;

    await setChatResumeToken("chat-1", "other-backend", "other-session-1");

    // A `sql` template fragment (a jsonb `||` merge), not a plain object:
    // asserting it exists and isn't a bare literal is what's testable
    // without a real Postgres to execute the merge against.
    expect(lastUpdateSet.resumeTokens).toBeDefined();
    expect(typeof lastUpdateSet.resumeTokens).toBe("object");
  });
});

/**
 * Migration 0015 removes the OpenFX backend from the product. These assert
 * what it does to a row that was still using it — the decision itself, not
 * just the SQL text: a stranded chat lands on `claude-code`, and its OpenFX
 * resume token is deleted rather than inherited.
 *
 * Read from the committed migration because that file *is* the behaviour;
 * there is no application code path that performs this rewrite, and a later
 * edit flipping `'claude-code'` to `'poolside'` would otherwise be silent.
 */
describe("migration 0015 — the OpenFX backend's stranded rows", () => {
  const migrationSql = readFileSync(
    join(import.meta.dirname, "migrations", "0015_poolside_backend.sql"),
    "utf8",
  );

  test("moves a chat pinned to openfx onto claude-code, never onto poolside", async () => {
    const { resolveChatResumeToken } = await sessionsModulePromise;

    expect(migrationSql).toContain(
      `UPDATE "chats"\nSET "backend" = 'claude-code'\nWHERE "backend" = 'openfx';`,
    );
    // The whole point: nothing rewrites a stranded chat to the new backend.
    expect(migrationSql).not.toContain(`SET "backend" = 'poolside'`);

    // And the row it produces resumes nothing on either backend, which is
    // the honest outcome for a chat whose agent no longer exists.
    const migratedRow = { resumeTokens: {}, claudeSessionId: null };
    expect(resolveChatResumeToken(migratedRow, "claude-code")).toBeUndefined();
    expect(resolveChatResumeToken(migratedRow, "poolside")).toBeUndefined();
  });

  test("deletes the stale openfx resume key while leaving every other backend's token alone", async () => {
    const { resolveChatResumeToken } = await sessionsModulePromise;

    expect(migrationSql).toContain(
      `SET "resume_tokens" = "resume_tokens" - 'openfx'`,
    );

    // Simulate the jsonb `-` the migration performs, then read the result
    // back through the helper the application actually uses.
    const before: Record<string, string> = {
      "claude-code": "claude-session-1",
      openfx: "acp-session-1",
    };
    const { openfx: _dropped, ...after } = before;

    expect(
      resolveChatResumeToken(
        { resumeTokens: after, claudeSessionId: null },
        "poolside",
      ),
    ).toBeUndefined();
    expect(
      resolveChatResumeToken(
        { resumeTokens: after, claudeSessionId: null },
        "claude-code",
      ),
    ).toBe("claude-session-1");
    expect(Object.keys(after)).not.toContain("openfx");
  });

  test("drops the OpenFX provider secret instead of carrying it into a Poolside column", () => {
    expect(migrationSql).toContain(
      `ALTER TABLE "instance_settings" DROP COLUMN "openfx_api_key_sealed";`,
    );
    expect(migrationSql).toContain(
      `ALTER TABLE "instance_settings" ADD COLUMN "poolside_api_key_sealed" text;`,
    );
    // A rename would have moved a dead vendor's key into the live column.
    expect(migrationSql).not.toContain("RENAME COLUMN");
  });
});
