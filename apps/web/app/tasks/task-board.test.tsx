import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
// `TaskColumns` lives in `task-columns.tsx`, not `task-board.tsx` itself,
// specifically so this test can import it without pulling in `./actions` —
// a `"use server"` file whose real dependency chain reaches a live Postgres
// client and workflow machinery. `TaskBoardItem` here is a type-only import
// (erased at compile time), so it never touches that module at runtime.
import type { TaskBoardItem } from "./actions";
import { TaskColumns } from "./task-columns";

function task(overrides: Partial<TaskBoardItem> = {}): TaskBoardItem {
  return {
    id: "task-1",
    title: "Ship the feature",
    goal: "Ship the feature end to end",
    status: "todo",
    sessionId: "session-1",
    sessionTitle: "My session",
    chatId: null,
    assignedAgent: null,
    origin: "user",
    reviewerRejections: 0,
    resultSummary: null,
    isLeaf: true,
    ...overrides,
  };
}

const noop = () => {
  // intentionally empty
};

function renderColumns(tasks: TaskBoardItem[] | null) {
  return renderToStaticMarkup(
    <TaskColumns
      onRetry={noop}
      onStart={noop}
      onStartSubtasks={noop}
      onUnblock={noop}
      pending={{}}
      tasks={tasks}
    />,
  );
}

describe("TaskColumns", () => {
  test("renders all six status columns", () => {
    const html = renderColumns([]);

    expect(html).toContain("Todo");
    expect(html).toContain("Running");
    expect(html).toContain("Blocked");
    expect(html).toContain("Review");
    expect(html).toContain("Done");
    expect(html).toContain("Failed");
  });

  test("renders a fixture task under its own status column", () => {
    const html = renderColumns([
      task({ id: "task-todo", title: "A todo task", status: "todo" }),
      task({ id: "task-running", title: "A running task", status: "running" }),
      task({ id: "task-done", title: "A done task", status: "done" }),
    ]);

    expect(html).toContain("A todo task");
    expect(html).toContain("A running task");
    expect(html).toContain("A done task");
  });

  test("shows the session name, assigned agent, origin, and rejection count", () => {
    const html = renderColumns([
      task({
        sessionTitle: "The web app",
        assignedAgent: "executor",
        origin: "planner",
        reviewerRejections: 2,
      }),
    ]);

    expect(html).toContain("The web app");
    expect(html).toContain("executor");
    expect(html).toContain("Planner");
    expect(html).toContain("2 rejections");
  });

  test("does not show a rejection badge when there have been none", () => {
    const html = renderColumns([task({ reviewerRejections: 0 })]);

    expect(html).not.toContain("rejection");
  });

  test("links to the executing chat when the task has one", () => {
    const html = renderColumns([
      task({ sessionId: "session-9", chatId: "chat-9" }),
    ]);

    expect(html).toContain('href="/sessions/session-9/chats/chat-9"');
  });

  test("shows no chat link for a task that has not started", () => {
    const html = renderColumns([task({ chatId: null })]);

    expect(html).not.toContain("Open chat");
  });

  test("Start is shown for a todo leaf task", () => {
    const html = renderColumns([task({ status: "todo", isLeaf: true })]);

    expect(html).toContain("Start");
  });

  test("a todo grouping node offers Start subtasks instead of Start", () => {
    const html = renderColumns([task({ status: "todo", isLeaf: false })]);

    // `startTask` refuses a task with children, so offering it Start would
    // be a button that can only fail. Without SOME action it is a dead card
    // — one per plan, forever — so it gets the action that does apply.
    expect(html).toContain("Start subtasks");
    expect(html).not.toContain("Start</button>");
  });

  test("a todo leaf offers Start, never Start subtasks", () => {
    const html = renderColumns([task({ status: "todo", isLeaf: true })]);

    expect(html).toContain("Start</button>");
    expect(html).not.toContain("Start subtasks");
  });

  test("Start subtasks stays available while the plan is running", () => {
    // Roll-up moves a plan root to `running` the moment its first subtask
    // starts (`nextForPlanRoot`), and the subtasks that have not started yet
    // still need a way to be set going in one go.
    const html = renderColumns([task({ status: "running", isLeaf: false })]);

    expect(html).toContain("Start subtasks");
  });

  test("Start subtasks is not offered for a grouping node that has settled", () => {
    for (const status of ["blocked", "review", "done", "failed"] as const) {
      const html = renderColumns([task({ status, isLeaf: false })]);
      expect(html).not.toContain("Start subtasks");
    }
  });

  test("Start is not shown for a task in any other status", () => {
    for (const status of [
      "running",
      "blocked",
      "review",
      "done",
      "failed",
    ] as const) {
      const html = renderColumns([task({ status, isLeaf: true })]);
      expect(html).not.toContain("Start");
    }
  });

  test("Retry is shown only for a failed task", () => {
    expect(renderColumns([task({ status: "failed" })])).toContain("Retry");
    expect(renderColumns([task({ status: "todo" })])).not.toContain("Retry");
  });

  test("Unblock is shown only for a blocked task", () => {
    expect(renderColumns([task({ status: "blocked" })])).toContain("Unblock");
    expect(renderColumns([task({ status: "running" })])).not.toContain(
      "Unblock",
    );
  });

  test("shows why a task blocked, so the operator is not left guessing", () => {
    const html = renderColumns([
      task({
        status: "blocked",
        resultSummary:
          'Not reviewed: backend "other" cannot produce structured output.',
      }),
    ]);

    expect(html).toContain("cannot produce structured output");
  });

  test("shows no summary line for a task that has none", () => {
    const html = renderColumns([task({ resultSummary: null })]);

    expect(html).not.toContain("task-result-summary");
  });

  test("renders loading skeletons rather than empty columns while tasks is null", () => {
    const html = renderColumns(null);

    // No task content, but the columns and their headers still render.
    expect(html).toContain("Todo");
    expect(html).not.toContain("Ship the feature");
  });
});
