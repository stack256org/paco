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
  userId: "user-1",
  title: "Original",
  sandboxState: null,
};

const fakeDb = {
  // Fluent select chain: db.select({…}).from(table).where(condition)
  select: (_columns: unknown) => ({
    from: (_table: unknown) => ({
      where: async (_condition: unknown) => fakeSelectRows,
    }),
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

  test("returns an empty Set when the user has no sessions", async () => {
    const { getUsedSessionTitles } = await sessionsModulePromise;
    fakeSelectRows = [];

    const result = await getUsedSessionTitles("user-1");
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

    const result = await getUsedSessionTitles("user-1");
    expect(result.size).toBe(3);
    expect(result.has("Tokyo")).toBe(true);
    expect(result.has("Paris")).toBe(true);
    expect(result.has("Lagos")).toBe(true);
  });

  test("deduplicates titles if the DB returns duplicates", async () => {
    const { getUsedSessionTitles } = await sessionsModulePromise;
    fakeSelectRows = [{ title: "Rome" }, { title: "Rome" }];

    const result = await getUsedSessionTitles("user-1");
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

  test("never writes the columns that say whose session this is", async () => {
    // The signature already excluded them, and a type is erased at runtime: the
    // PATCH handler cast its request body straight into here, and drizzle sets
    // every key that names a real column — so `{"userId": "<someone else>"}`
    // reassigned the row's owner.
    const { updateSession } = await sessionsModulePromise;

    await updateSession(
      "session-1",
      unvalidated({
        title: "Renamed",
        id: "session-2",
        userId: "user-2",
        createdAt: new Date(0),
      }),
    );

    expect(lastUpdateSet.title).toBe("Renamed");
    expect(lastUpdateSet).not.toHaveProperty("id");
    expect(lastUpdateSet).not.toHaveProperty("userId");
    expect(lastUpdateSet).not.toHaveProperty("createdAt");
  });

  test("leaves the caller's own object alone", async () => {
    // Sanitising by mutation would edit an object the caller still holds —
    // `archiveSession` builds one update and reuses it.
    const { updateSession } = await sessionsModulePromise;
    const data = unvalidated({ title: "Renamed", userId: "user-2" });

    await updateSession("session-1", data);

    expect(data).toHaveProperty("userId", "user-2");
  });

  test("updateSessionIfNotArchived drops the same columns", async () => {
    const { updateSessionIfNotArchived } = await sessionsModulePromise;

    await updateSessionIfNotArchived(
      "session-1",
      unvalidated({ status: "running", userId: "user-2" }),
    );

    expect(lastUpdateSet.status).toBe("running");
    expect(lastUpdateSet).not.toHaveProperty("userId");
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
