import "server-only";

import { generateId } from "ai";
import type { UIMessage } from "ai";
import { start } from "workflow/api";
import { z } from "zod";
import { runAgentWorkflow } from "@/app/workflows/chat";
import { runAgentTurn } from "@/lib/agent/run-step";
import { hostChatWorktree } from "@/lib/agent/workspace-paths";
import { getRoster } from "@/lib/db/roster";
import type { SessionRecord } from "@/lib/db/sessions";
import type { Task, TaskStatus } from "@/lib/db/schema";
import { claimChatActiveStreamId, getSessionById } from "@/lib/db/sessions";
import {
  TaskTransitionError,
  transitionTaskStatus,
  type TaskTransitionPatch,
} from "@/lib/db/tasks";
import { nextOnReviewerVerdict } from "@/lib/tasks/state";

/** Result of one automatic reviewer gate run. */
export type ReviewerGateOutcome = "pass" | "fail" | "skipped";

/** JSON Schema the reviewer's headless turn is constrained to. */
const REVIEWER_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    verdict: { enum: ["pass", "fail"] },
    problems: { type: "array", items: { type: "string" } },
  },
  required: ["verdict"],
};

const reviewerOutputSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  problems: z.array(z.string()).optional(),
});

/** Fallback tools when the reviewer roster row does not restrict its own. */
const DEFAULT_REVIEWER_TOOLS = ["Read", "Grep", "Glob", "Bash"];

/** Cap on the resultSummary column. */
const RESULT_SUMMARY_MAX_LENGTH = 500;

/** Timeout for the diff-summary shell-out; a slow git must not wedge the gate. */
const DIFF_SUMMARY_TIMEOUT_MS = 15_000;

const MALFORMED_PROBLEMS = ["reviewer output malformed"];

/**
 * Applies a task-board transition, swallowing a concurrent-update race.
 *
 * `transitionTaskStatus` throws `TaskTransitionError` both for an illegal
 * edge and for a concurrent writer that got there first (see its own
 * doc comment). Either way, this gate has already done its work — running
 * the reviewer turn, deciding the verdict — and a second writer racing it is
 * not a reason to crash the workflow step calling this. It is logged instead,
 * so the race is visible without taking the turn down.
 */
async function applyTransition(
  organizationId: string,
  taskId: string,
  to: TaskStatus,
  patch?: TaskTransitionPatch,
): Promise<void> {
  try {
    await transitionTaskStatus(organizationId, taskId, to, patch);
  } catch (error) {
    if (error instanceof TaskTransitionError) {
      console.error("[tasks] reviewer gate: transition race", {
        taskId,
        to,
        error: error.message,
      });
      return;
    }
    throw error;
  }
}

/** Joined text-part content from a turn's final assistant message. */
function extractLastText(message?: UIMessage): string {
  if (!message) {
    return "";
  }
  return message.parts
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** Best-effort `git diff --stat` of the chat branch against its base. */
async function buildDiffSummary(
  session: SessionRecord,
  chatId: string,
): Promise<string> {
  if (!session.sandboxState) {
    return "(no sandbox available to compute a diff summary)";
  }
  try {
    const { connectSandbox } = await import("@paco/sandbox");
    const sandbox = await connectSandbox(session.sandboxState);
    const cwd = hostChatWorktree(session.sandboxState, chatId);
    const base = session.branch ?? "main";
    const result = await sandbox.exec(
      `git diff ${base}...HEAD --stat`,
      cwd,
      DIFF_SUMMARY_TIMEOUT_MS,
    );
    if (!result.success) {
      return "(unable to compute diff summary)";
    }
    return result.stdout.trim() || "(no changes)";
  } catch (error) {
    console.error("[tasks] reviewer gate: failed to compute diff summary", {
      chatId,
      error,
    });
    return "(unable to compute diff summary)";
  }
}

function buildReviewerPrompt(
  task: Task,
  reviewerPrompt: string,
  diffSummary: string,
): string {
  return [
    reviewerPrompt,
    "",
    `Task goal: ${task.goal}`,
    "",
    "Diff summary (chat branch vs its base):",
    diffSummary,
  ].join("\n");
}

function buildFixPrompt(problems: string[]): string {
  const list =
    problems.length > 0
      ? problems.map((problem) => `- ${problem}`).join("\n")
      : "- (the reviewer did not list specific problems)";
  return `The reviewer rejected this work for these reasons — fix them:\n${list}`;
}

/**
 * Re-kicks one executor turn on the same chat, carrying the reviewer's
 * problems as the prompt.
 *
 * Mirrors `startTask`'s own kickoff (`lib/tasks/start.ts`): start the
 * workflow, then claim the chat's active-stream slot. Unlike `startTask`
 * this never creates a chat or a new branch — the point of a reviewer
 * rejection is another attempt on the exact same worktree, not a fresh one.
 */
async function kickExecutorFixTurn(params: {
  sessionId: string;
  chatId: string;
  userId: string;
  problems: string[];
}): Promise<void> {
  const run = await start(runAgentWorkflow, [
    {
      messages: [
        {
          id: generateId(),
          role: "user" as const,
          parts: [
            { type: "text" as const, text: buildFixPrompt(params.problems) },
          ],
        },
      ],
      chatId: params.chatId,
      sessionId: params.sessionId,
      userId: params.userId,
      requestUrl: "internal://tasks/reviewer-gate",
      authSession: null,
      assistantId: generateId(),
    },
  ]);

  const claimed = await claimChatActiveStreamId(params.chatId, run.runId);
  if (!claimed) {
    throw new Error(`Chat "${params.chatId}" already has an active run`);
  }
}

/**
 * No reviewer configured: auto-approve, but still record the `review` state
 * for the audit trail rather than jumping `running -> done` directly (the
 * state machine has no such edge, and the history would lie about it anyway).
 */
async function passWithoutReviewer(task: Task): Promise<ReviewerGateOutcome> {
  await applyTransition(task.organizationId, task.id, "review");
  await applyTransition(task.organizationId, task.id, "done", {
    resultSummary: "No reviewer configured; auto-approved.",
  });
  return "skipped";
}

type ReviewerVerdictOutcome = {
  verdict: "pass" | "fail";
  problems: string[];
  summary: string;
};

/** Runs the reviewer's one headless turn and normalizes its output. */
async function runReviewerTurn(
  task: Task,
  chatId: string,
  session: SessionRecord,
  reviewer: { prompt: string; model?: string; tools?: string[] },
): Promise<ReviewerVerdictOutcome> {
  if (!session.sandboxState) {
    return {
      verdict: "fail",
      problems: ["reviewer could not run: no active sandbox for this task"],
      summary: "",
    };
  }

  const diffSummary = await buildDiffSummary(session, chatId);
  const cwd = hostChatWorktree(session.sandboxState, chatId);

  const result = await runAgentTurn({
    prompt: buildReviewerPrompt(task, reviewer.prompt, diffSummary),
    options: {
      sandbox: {
        state: session.sandboxState,
        workingDirectory: cwd,
        hostWorkingDirectory: cwd,
      },
      ...(reviewer.model && { model: { id: reviewer.model } }),
      tools: reviewer.tools ?? DEFAULT_REVIEWER_TOOLS,
      structuredOutput: { jsonSchema: REVIEWER_JSON_SCHEMA },
    },
    messageId: generateId(),
    originalMessages: [],
    maxTurns: 15,
    onChunk: () => Promise.resolve(),
  });

  const summary = extractLastText(result.responseMessage);
  const parsed = reviewerOutputSchema.safeParse(result.structuredOutput);

  if (result.isError || !parsed.success) {
    return { verdict: "fail", problems: MALFORMED_PROBLEMS, summary };
  }

  return {
    verdict: parsed.data.verdict,
    problems: parsed.data.problems ?? [],
    summary,
  };
}

/**
 * Gates a task's completion behind the reviewer roster agent.
 *
 * Called once a chat's turn finishes cleanly for a `running` task (see
 * `runTaskCompletionStep` in `app/workflows/chat-post-finish.ts`). With no
 * enabled `reviewer` in the org roster, the task is auto-approved
 * (`"skipped"`). Otherwise runs one headless reviewer turn against the
 * chat's worktree, applies `nextOnReviewerVerdict`, and — on a rejection
 * with retries left — re-kicks one executor fix turn on the same chat. The
 * rejection counter (`lib/tasks/state.ts`, capped at 2) bounds that loop:
 * a third failure blocks the task for a human instead of re-kicking again.
 */
export async function runReviewerGate(
  task: Task,
  chatId: string,
): Promise<ReviewerGateOutcome> {
  const roster = await getRoster(task.organizationId);
  const reviewer = roster.reviewer;

  if (!reviewer) {
    return await passWithoutReviewer(task);
  }

  await applyTransition(task.organizationId, task.id, "review");

  const session = await getSessionById(task.sessionId);

  const { verdict, problems, summary } = session
    ? await runReviewerTurn(task, chatId, session, reviewer)
    : {
        verdict: "fail" as const,
        problems: ["reviewer could not run: session not found"],
        summary: "",
      };

  const next = nextOnReviewerVerdict(
    { status: "review", reviewerRejections: task.reviewerRejections },
    verdict,
  );

  if (next.status === "done") {
    await applyTransition(task.organizationId, task.id, "done", {
      resultSummary: (summary || "Reviewer approved.").slice(
        0,
        RESULT_SUMMARY_MAX_LENGTH,
      ),
      reviewerRejections: next.reviewerRejections,
    });
    return "pass";
  }

  if (next.status === "blocked") {
    await applyTransition(task.organizationId, task.id, "blocked", {
      reviewerRejections: next.reviewerRejections,
      resultSummary: problems.join("; ").slice(0, RESULT_SUMMARY_MAX_LENGTH),
    });
    return "fail";
  }

  // next.status === "running": a rejection with retries left.
  await applyTransition(task.organizationId, task.id, "running", {
    reviewerRejections: next.reviewerRejections,
  });

  if (session) {
    try {
      await kickExecutorFixTurn({
        sessionId: task.sessionId,
        chatId,
        userId: session.userId,
        problems,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await applyTransition(task.organizationId, task.id, "failed", {
        resultSummary: message,
      });
    }
  }

  return "fail";
}
