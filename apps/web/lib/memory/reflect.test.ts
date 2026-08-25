import { beforeEach, describe, expect, mock, test } from "bun:test";

// The module under test is server-only; the marker package throws outside a
// server component and has nothing to do with what is being tested.
mock.module("server-only", () => ({}));

interface FakeRow {
  chatId: string;
  payload: unknown;
  createdAt: Date;
}

let selectRows: FakeRow[] = [];

/**
 * Fluent chain matching `reflect.ts`'s exact query shape:
 * `db.select({...}).from(sessionEvents).innerJoin(...).innerJoin(...).innerJoin(...).where(...).orderBy(...)`.
 * The arguments each link is handed are irrelevant to this fake — the
 * mocked rows already stand in for whatever a real join+filter would
 * produce, in the order a real `orderBy(desc(...))` would return them.
 */
const fakeDb = {
  select: (_columns: unknown) => ({
    from: (_table: unknown) => ({
      innerJoin: (_t1: unknown, _c1: unknown) => ({
        innerJoin: (_t2: unknown, _c2: unknown) => ({
          innerJoin: (_t3: unknown, _c3: unknown) => ({
            where: (_condition: unknown) => ({
              orderBy: (_order: unknown) => Promise.resolve(selectRows),
            }),
          }),
        }),
      }),
    }),
  }),
};

mock.module("@/lib/db/client", () => ({ db: fakeDb }));

type CreateTaskInput = {
  organizationId: string;
  sessionId: string | null;
  title: string;
  goal: string;
  origin?: string;
  initialStatus?: "todo" | "blocked";
};

let createdTasks: CreateTaskInput[] = [];
const createTaskSpy = mock((input: CreateTaskInput) => {
  createdTasks.push(input);
  return Promise.resolve({ id: `task-${createdTasks.length}`, ...input });
});

mock.module("@/lib/db/tasks", () => ({
  createTask: createTaskSpy,
}));

type GenerateObjectOptions = {
  cwd: string;
  model: string;
  appendSystemPrompt?: string;
};

let generateObjectResult: unknown = { proposals: [] };
const generateObjectSpy = mock(
  (
    _prompt: string,
    _schema: Record<string, unknown>,
    _options: GenerateObjectOptions,
  ) => Promise.resolve(generateObjectResult),
);

mock.module("@paco/claude-code", () => ({
  generateObject: generateObjectSpy,
}));

const { reflectOnRecentSessions } = await import("./reflect");

const ORG_ID = "org-1";

function turnRow(overrides?: Partial<FakeRow> & { prompt?: string }): FakeRow {
  const { prompt = "do the thing", ...rest } = overrides ?? {};
  return {
    chatId: "chat-1",
    payload: {
      type: "turn/start",
      turnId: `turn-${Math.random()}`,
      messageId: `msg-${Math.random()}`,
      prompt,
      policy: "queue",
    },
    createdAt: new Date(),
    ...rest,
  };
}

beforeEach(() => {
  selectRows = [];
  createdTasks = [];
  generateObjectResult = { proposals: [] };
  createTaskSpy.mockClear();
  generateObjectSpy.mockClear();
  generateObjectSpy.mockImplementation(
    (
      _prompt: string,
      _schema: Record<string, unknown>,
      _options: GenerateObjectOptions,
    ) => Promise.resolve(generateObjectResult),
  );
});

describe("reflectOnRecentSessions gathering", () => {
  test("caps at 50 turns, keeping the newest first", async () => {
    // Rows already arrive newest-first, as a real `orderBy(desc(...))`
    // would return them; index 0 is "prompt-0" (newest).
    selectRows = Array.from({ length: 60 }, (_, i) =>
      turnRow({ prompt: `prompt-${i}` }),
    );

    await reflectOnRecentSessions({ organizationId: ORG_ID });

    expect(generateObjectSpy).toHaveBeenCalledTimes(1);
    const transcript = generateObjectSpy.mock.calls[0]?.[0] as string;
    for (let i = 0; i < 50; i++) {
      expect(transcript).toContain(`prompt-${i}`);
    }
    for (let i = 50; i < 60; i++) {
      expect(transcript).not.toContain(`prompt-${i}`);
    }
  });

  test("skips the model call entirely when there are no recent turns", async () => {
    selectRows = [];

    const result = await reflectOnRecentSessions({ organizationId: ORG_ID });

    expect(result).toEqual({ proposals: 0 });
    expect(generateObjectSpy).not.toHaveBeenCalled();
  });

  test("calls the model with model 'sonnet'", async () => {
    selectRows = [turnRow()];

    await reflectOnRecentSessions({ organizationId: ORG_ID });

    const options = generateObjectSpy.mock.calls[0]?.[2] as
      | GenerateObjectOptions
      | undefined;
    expect(options?.model).toBe("sonnet");
  });

  test("ignores non-turn-start rows", async () => {
    selectRows = [
      turnRow({ prompt: "keep-me" }),
      {
        chatId: "chat-2",
        payload: { type: "usage/reported", turnId: "t2", usage: {} },
        createdAt: new Date(),
      },
    ];

    await reflectOnRecentSessions({ organizationId: ORG_ID });

    const transcript = generateObjectSpy.mock.calls[0]?.[0] as string;
    expect(transcript).toContain("keep-me");
  });
});

describe("reflectOnRecentSessions proposals", () => {
  test("zero proposals from the model creates no tasks", async () => {
    selectRows = [turnRow()];
    generateObjectResult = { proposals: [] };

    const result = await reflectOnRecentSessions({ organizationId: ORG_ID });

    expect(result).toEqual({ proposals: 0 });
    expect(createTaskSpy).not.toHaveBeenCalled();
  });

  test("each proposal becomes a blocked, session-less reflection task", async () => {
    selectRows = [turnRow()];
    generateObjectResult = {
      proposals: [
        {
          title: "Always run the narrow check first",
          rationale:
            "The same instruction to run the scoped test file before the full suite was repeated in three sessions this week.",
          proposedSkillMarkdown:
            "# Run narrow checks first\n\nRun the single test file before `pnpm run ci`.",
        },
      ],
    };

    const result = await reflectOnRecentSessions({ organizationId: ORG_ID });

    expect(result).toEqual({ proposals: 1 });
    expect(createTaskSpy).toHaveBeenCalledTimes(1);
    const created = createdTasks[0];
    expect(created?.organizationId).toBe(ORG_ID);
    expect(created?.sessionId).toBeNull();
    expect(created?.origin).toBe("reflection");
    expect(created?.initialStatus).toBe("blocked");
    expect(created?.title).toBe(
      "Skill proposal: Always run the narrow check first",
    );
    expect(created?.goal).toContain(
      "The same instruction to run the scoped test file",
    );
    expect(created?.goal).toContain("```markdown");
    expect(created?.goal).toContain("# Run narrow checks first");
  });

  test("caps at 3 tasks when the model somehow returns more", async () => {
    selectRows = [turnRow()];
    // The schema itself caps this at 3 (`.max(3)`), so a 4th entry makes the
    // structured output fail validation — this exercises that as malformed
    // output, not a fourth task being created.
    generateObjectResult = {
      proposals: Array.from({ length: 4 }, (_, i) => ({
        title: `Proposal ${i}`,
        rationale: "rationale",
        proposedSkillMarkdown: "# skill",
      })),
    };

    const result = await reflectOnRecentSessions({ organizationId: ORG_ID });

    expect(result).toEqual({ proposals: 0 });
    expect(createTaskSpy).not.toHaveBeenCalled();
  });
});

describe("reflectOnRecentSessions resilience", () => {
  test("never throws when the model call rejects", async () => {
    selectRows = [turnRow()];
    generateObjectSpy.mockImplementation(() =>
      Promise.reject(new Error("CLI crashed")),
    );

    await expect(
      reflectOnRecentSessions({ organizationId: ORG_ID }),
    ).resolves.toEqual({ proposals: 0 });
    expect(createTaskSpy).not.toHaveBeenCalled();
  });

  test("never throws on malformed structured output", async () => {
    selectRows = [turnRow()];
    generateObjectResult = { proposals: [{ title: 42 }] };

    await expect(
      reflectOnRecentSessions({ organizationId: ORG_ID }),
    ).resolves.toEqual({ proposals: 0 });
    expect(createTaskSpy).not.toHaveBeenCalled();
  });
});
