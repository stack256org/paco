import "server-only";

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionEvent } from "@paco/agent-backend";
import type { SandboxState } from "@paco/sandbox";
import { generateId } from "ai";
import { nanoid } from "nanoid";
import { hostChatWorktree } from "@/lib/agent/workspace-paths";
import { deriveAssistantMessage } from "@/lib/chat/derive-from-events";
import { submitChatMessage } from "@/lib/chat/submit-message";
import {
  type EvalAssertionResult,
  type EvalRunDetails,
  finishEvalRun,
  startEvalRun,
} from "@/lib/db/eval-runs";
import { getRoster } from "@/lib/db/roster";
import type { EvalRun } from "@/lib/db/schema";
import {
  appendSessionEvents,
  listSessionEvents,
} from "@/lib/db/session-events";
import { createChat, deleteChat, getSessionById } from "@/lib/db/sessions";
import { getUserPreferences } from "@/lib/db/user-preferences";
import type { EvalAssertion, EvalScenario } from "@/lib/evals/discovery";
import { removeChatWorktree } from "@/lib/sandbox/chat-worktree-removal";

/** `runEvalScenario`'s result: the finished (or errored) `evalRuns` row. */
export type EvalRunRow = EvalRun;

export interface RunEvalScenarioParams {
  organizationId: string;
  sessionId: string;
  scenario: EvalScenario;
  /**
   * Overrides for `waitForRunCompletion`, used by tests so a "the turn never
   * finishes" case doesn't actually wait `EVAL_RUN_TIMEOUT_MS` in real time.
   * Production callers never need these — the defaults are the real cap.
   */
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * How long a scenario's turn is allowed to run before it is treated as a
 * harness failure. An eval that never finishes must not hang the run (or
 * whatever server action awaited it) forever.
 */
export const EVAL_RUN_TIMEOUT_MS = 10 * 60 * 1000;

const RUN_POLL_INTERVAL_MS = 2000;
const COMMAND_ASSERTION_TIMEOUT_MS = 60_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type RunCompletion =
  | { ok: true }
  | { ok: false; reason: "failed" | "cancelled" | "timeout" };

/**
 * Polls a workflow run to completion, capped at `timeoutMs`.
 *
 * Uses `getRun(runId).status` rather than the `returnValue` getter: the
 * latter throws on failure/cancellation instead of resolving, which would
 * mean threading a try/catch through what is otherwise a plain "did it
 * finish" loop — the same status-polling shape `provisioning-kick.ts`'s
 * `isRunStillLive` and `chat.ts`'s `startStopMonitor` already use for this
 * runtime.
 */
async function waitForRunCompletion(
  runId: string,
  opts: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<RunCompletion> {
  const timeoutMs = opts.timeoutMs ?? EVAL_RUN_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? RUN_POLL_INTERVAL_MS;

  const { getRun } = await import("workflow/api");
  const run = getRun(runId);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const status = await run.status;
    if (status === "completed") {
      return { ok: true };
    }
    if (status === "failed") {
      return { ok: false, reason: "failed" };
    }
    if (status === "cancelled") {
      return { ok: false, reason: "cancelled" };
    }
    if (Date.now() >= deadline) {
      return { ok: false, reason: "timeout" };
    }
    await delay(pollIntervalMs);
  }
}

/** Joined text-part content of a turn's assistant message, "" when none. */
function transcriptTextOf(message?: { parts: unknown[] }): string {
  if (!message) {
    return "";
  }
  return message.parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

/**
 * Replays the eval turn's assistant text from `session_events` — the same
 * derivation the chat UI uses to replay a turn, so `transcript-matches`
 * checks the same text a person would see, not a separate live-only value.
 *
 * Returns "" when the turn's `turn/start` event cannot be found (nothing
 * ever ran) rather than throwing: a scenario with no `transcript-matches`
 * assertion should not fail over this.
 */
function isMatchingTurnStart(
  event: SessionEvent,
  userMessageId: string,
): event is Extract<SessionEvent, { type: "turn/start" }> {
  return event.type === "turn/start" && event.messageId === userMessageId;
}

async function loadTranscript(
  chatId: string,
  userMessageId: string,
): Promise<string> {
  const rows = await listSessionEvents(chatId);
  const events = rows.map((row) => row.event);
  const turnStart = events.find(
    (event): event is Extract<SessionEvent, { type: "turn/start" }> =>
      isMatchingTurnStart(event, userMessageId),
  );
  if (!turnStart) {
    return "";
  }
  const assistantMessage = await deriveAssistantMessage(
    events,
    turnStart.turnId,
    "eval-transcript",
  );
  return transcriptTextOf(assistantMessage);
}

interface AssertionContext {
  hostWorktree: string;
  sandboxState: SandboxState;
  transcript: string;
}

function assertionMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function evaluateFileExists(
  assertion: Extract<EvalAssertion, { kind: "file-exists" }>,
  ctx: AssertionContext,
): Promise<EvalAssertionResult> {
  const description = `file exists: ${assertion.path}`;
  try {
    await fs.access(path.join(ctx.hostWorktree, assertion.path));
    return { kind: assertion.kind, description, passed: true };
  } catch {
    return {
      kind: assertion.kind,
      description,
      passed: false,
      message: `"${assertion.path}" does not exist`,
    };
  }
}

async function evaluateFileContains(
  assertion: Extract<EvalAssertion, { kind: "file-contains" }>,
  ctx: AssertionContext,
): Promise<EvalAssertionResult> {
  const description = `file contains: ${assertion.path}`;
  try {
    const content = await fs.readFile(
      path.join(ctx.hostWorktree, assertion.path),
      "utf8",
    );
    if (content.includes(assertion.needle)) {
      return { kind: assertion.kind, description, passed: true };
    }
    return {
      kind: assertion.kind,
      description,
      passed: false,
      message: `"${assertion.path}" does not contain "${assertion.needle}"`,
    };
  } catch (error) {
    return {
      kind: assertion.kind,
      description,
      passed: false,
      message: assertionMessage(error),
    };
  }
}

async function evaluateCommandSucceeds(
  assertion: Extract<EvalAssertion, { kind: "command-succeeds" }>,
  ctx: AssertionContext,
): Promise<EvalAssertionResult> {
  const description = `command succeeds: ${assertion.command}`;
  try {
    const { connectSandbox } = await import("@paco/sandbox");
    const sandbox = await connectSandbox(ctx.sandboxState);
    const result = await sandbox.exec(
      assertion.command,
      ctx.hostWorktree,
      COMMAND_ASSERTION_TIMEOUT_MS,
    );
    if (result.success) {
      return { kind: assertion.kind, description, passed: true };
    }
    return {
      kind: assertion.kind,
      description,
      passed: false,
      message: result.stderr.trim() || `exited with code ${result.exitCode}`,
    };
  } catch (error) {
    return {
      kind: assertion.kind,
      description,
      passed: false,
      message: assertionMessage(error),
    };
  }
}

/**
 * How long the sandboxed `grep -E` a `transcript-matches` assertion runs as
 * may take before it is killed.
 *
 * Short on purpose: this is matching one regex against one turn's transcript
 * — normally sub-millisecond work — so 5s is already a generous margin
 * before treating it as runaway, not a budget anyone should expect to need.
 */
const TRANSCRIPT_MATCH_TIMEOUT_MS = 5_000;

/**
 * Checks a `transcript-matches` assertion by running `grep -E` inside the
 * sandbox, never a JS `RegExp` on the web server process.
 *
 * A repo-defined pattern is trusted the way a scenario's `prompt` or
 * `command` already is, but a regex is a sharper kind of trust: a
 * pathological one (nested quantifiers over a long non-matching string) can
 * make a backtracking engine burn CPU exponentially on purely well-formed
 * input, no malice required. `command-succeeds` already keeps exactly this
 * class of risk off the server by running inside the sandbox with a timeout
 * — this reuses that same isolation rather than inventing a second one, and
 * two things about `grep -E` make it a materially safer engine to point at
 * untrusted patterns than JS's backtracking `RegExp` in the first place: GNU
 * grep's ERE matcher is DFA/NFA-based, not backtracking, so it does not
 * suffer catastrophic backtracking the way JS's engine can; the sandbox exec
 * timeout is still a hard backstop underneath that.
 *
 * The transcript and pattern are written to temp files inside the worktree
 * (the same host directory that is the sandbox's cwd for `exec`) rather than
 * interpolated into the shell command, so a pattern containing quotes or
 * shell metacharacters can never break — or inject into — the command line.
 * Both files are removed in `finally`, win or lose.
 */
async function evaluateTranscriptMatches(
  assertion: Extract<EvalAssertion, { kind: "transcript-matches" }>,
  ctx: AssertionContext,
): Promise<EvalAssertionResult> {
  const description = `transcript matches: ${assertion.pattern}`;
  const runId = nanoid();
  const transcriptFilename = `paco-eval-transcript-${runId}.txt`;
  const patternFilename = `paco-eval-pattern-${runId}.txt`;
  const transcriptPath = path.join(ctx.hostWorktree, transcriptFilename);
  const patternPath = path.join(ctx.hostWorktree, patternFilename);

  try {
    await fs.writeFile(transcriptPath, ctx.transcript, "utf8");
    await fs.writeFile(patternPath, `${assertion.pattern}\n`, "utf8");

    const { connectSandbox } = await import("@paco/sandbox");
    const sandbox = await connectSandbox(ctx.sandboxState);
    const result = await sandbox.exec(
      `grep -Eqf ${JSON.stringify(patternFilename)} ${JSON.stringify(transcriptFilename)}`,
      ctx.hostWorktree,
      TRANSCRIPT_MATCH_TIMEOUT_MS,
    );

    if (result.exitCode === 0) {
      return { kind: assertion.kind, description, passed: true };
    }
    if (result.exitCode === null) {
      return {
        kind: assertion.kind,
        description,
        passed: false,
        message: "pattern match timed out",
      };
    }
    if (result.exitCode === 1) {
      return {
        kind: assertion.kind,
        description,
        passed: false,
        message: "the transcript did not match the pattern",
      };
    }
    return {
      kind: assertion.kind,
      description,
      passed: false,
      message:
        result.stderr.trim() ||
        `invalid pattern (grep exited with code ${result.exitCode})`,
    };
  } catch (error) {
    return {
      kind: assertion.kind,
      description,
      passed: false,
      message: assertionMessage(error),
    };
  } finally {
    await Promise.all([
      fs.rm(transcriptPath, { force: true }).catch(() => undefined),
      fs.rm(patternPath, { force: true }).catch(() => undefined),
    ]);
  }
}

/** Evaluates one assertion. Never throws — a failure becomes `passed: false`. */
async function evaluateAssertion(
  assertion: EvalAssertion,
  ctx: AssertionContext,
): Promise<EvalAssertionResult> {
  switch (assertion.kind) {
    case "file-exists":
      return await evaluateFileExists(assertion, ctx);
    case "file-contains":
      return await evaluateFileContains(assertion, ctx);
    case "command-succeeds":
      return await evaluateCommandSucceeds(assertion, ctx);
    case "transcript-matches":
      return await evaluateTranscriptMatches(assertion, ctx);
    default:
      return assertion satisfies never;
  }
}

function harnessError(message: string): EvalRunDetails {
  return { assertions: [], harnessError: message };
}

/**
 * Runs one repo-defined eval scenario end-to-end: a throwaway chat, one
 * turn with the scenario's prompt (capped at `scenario.maxTurns`), every
 * assertion evaluated against the result, and — always, even on a thrown
 * error — the throwaway chat cleaned up.
 *
 * The org's current roster is snapshotted before the turn starts
 * (`rosterSnapshot`, see `lib/db/eval-runs.ts`) so a later "did my roster
 * edit make this worse" comparison has something concrete to point at.
 *
 * A harness failure (the turn never started, it failed/was cancelled, or it
 * timed out) lands as `status: "error"` with the reason recorded — never a
 * thrown exception out of this function, and never left in `"running"`.
 */
export async function runEvalScenario(
  params: RunEvalScenarioParams,
): Promise<EvalRunRow> {
  const { organizationId, sessionId, scenario } = params;

  const rosterSnapshot = await getRoster(organizationId);
  const run = await startEvalRun({
    organizationId,
    sessionId,
    scenarioName: scenario.name,
    rosterSnapshot,
  });

  let chatId: string | undefined;

  /**
   * Finishes the run and records `eval/finished` on the throwaway chat's
   * session log — but only once that chat exists: the very first check
   * below (`getSessionById` before `createChat`) can fail before there is
   * any chat to append to, so `chatId` is still `undefined` at that point
   * and the event is skipped silently, the same "chatId nullable -> skip"
   * rule task lifecycle events follow (`lib/db/tasks.ts`). Uses the
   * never-throwing `appendSessionEvents` so recording the event can never
   * turn a finished eval run into a harness failure.
   */
  async function finish(finishParams: {
    status: Exclude<EvalRun["status"], "running">;
    details: EvalRunDetails;
  }): Promise<EvalRunRow> {
    const finished = await finishEvalRun(run.id, finishParams);
    if (chatId) {
      await appendSessionEvents(chatId, [
        {
          type: "eval/finished",
          evalRunId: finished.id,
          scenarioName: scenario.name,
          status: finishParams.status,
        },
      ]);
    }
    return finished;
  }

  try {
    const session = await getSessionById(sessionId);
    if (!session) {
      return await finish({
        status: "error",
        details: harnessError(`Session "${sessionId}" not found`),
      });
    }

    const preferences = await getUserPreferences(session.userId);
    const chat = await createChat({
      id: nanoid(),
      sessionId,
      title: `Eval: ${scenario.name}`,
      modelId: preferences.defaultModelId,
    });
    chatId = chat.id;

    const userMessageId = generateId();
    const outcome = await submitChatMessage({
      chatId: chat.id,
      sessionId,
      userId: session.userId,
      messages: [
        {
          id: userMessageId,
          role: "user" as const,
          parts: [{ type: "text" as const, text: scenario.prompt }],
        },
      ],
      requestUrl: "internal://evals/run",
      authSession: null,
      sessionStatus: session.status,
      activeStreamId: chat.activeStreamId ?? null,
      maxSteps: scenario.maxTurns,
    });

    if (outcome.kind !== "streaming") {
      return await finish({
        status: "error",
        details: harnessError(
          `Failed to start the eval turn: chat submission returned "${outcome.kind}"`,
        ),
      });
    }

    const completion = await waitForRunCompletion(outcome.runId, {
      timeoutMs: params.timeoutMs,
      pollIntervalMs: params.pollIntervalMs,
    });
    if (!completion.ok) {
      const message =
        completion.reason === "timeout"
          ? `Eval turn timed out after ${Math.round(
              (params.timeoutMs ?? EVAL_RUN_TIMEOUT_MS) / 60_000,
            )} minute(s)`
          : `Eval turn ${completion.reason}`;
      return await finish({
        status: "error",
        details: harnessError(message),
      });
    }

    const finishedSession = await getSessionById(sessionId);
    if (!finishedSession?.sandboxState) {
      return await finish({
        status: "error",
        details: harnessError(
          "Eval turn completed but the session has no sandbox to check assertions against",
        ),
      });
    }

    const transcript = await loadTranscript(chat.id, userMessageId);
    const assertionCtx: AssertionContext = {
      hostWorktree: hostChatWorktree(finishedSession.sandboxState, chat.id),
      sandboxState: finishedSession.sandboxState,
      transcript,
    };

    const assertions: EvalAssertionResult[] = [];
    for (const assertion of scenario.assertions) {
      assertions.push(await evaluateAssertion(assertion, assertionCtx));
    }

    const allPassed = assertions.every((result) => result.passed);
    return await finish({
      status: allPassed ? "passed" : "failed",
      details: { assertions },
    });
  } catch (error) {
    return await finish({
      status: "error",
      details: harnessError(assertionMessage(error)),
    });
  } finally {
    if (chatId) {
      const cleanupChatId = chatId;
      try {
        // The files go before the row here too — same invariant the chat
        // DELETE route enforces (`lib/sandbox/chat-worktree-removal.ts`).
        // Re-fetching the session gets the sandbox state as it stands right
        // now, not whatever this function last saw before the turn ran.
        const cleanupSession = await getSessionById(sessionId);
        const removal = await removeChatWorktree(
          cleanupSession?.sandboxState,
          cleanupChatId,
        );

        if (removal.kind === "removed" || removal.kind === "already-absent") {
          await deleteChat(cleanupChatId);
        } else {
          // Leave the row: it is the only thing left pointing at whatever
          // worktree may still be on disk. Deleting it here would recreate
          // exactly the invisible-orphan bug this cleanup exists to prevent
          // — the chat can still be removed later, through the same retry
          // path a user's own chat delete goes through.
          const reason =
            removal.kind === "failed" ? ` (${removal.reason})` : "";
          console.error(
            `[evals] leaving throwaway chat "${cleanupChatId}" undeleted: worktree removal ${removal.kind}${reason}`,
          );
        }
      } catch (cleanupError) {
        console.error(
          `[evals] failed to clean up throwaway chat "${cleanupChatId}":`,
          cleanupError,
        );
      }
    }
  }
}
