import "server-only";

import type { ClaudeAgentDefinition } from "@paco/claude-code";
import type { UIMessage } from "ai";
import { nanoid } from "nanoid";
import { z } from "zod";
import { runAgentTurn } from "@/lib/agent/run-step";
import { resolveWorkCwd } from "@/lib/agent/workspace-paths";
import { getRoster } from "@/lib/db/roster";
import { getSessionById } from "@/lib/db/sessions";
import { createTask } from "@/lib/db/tasks";

/**
 * The tools a planning turn gets: read-only exploration of the session
 * repo, nothing that could change it.
 *
 * The planner only needs to understand the codebase well enough to write a
 * sensible task tree — it never implements anything itself, so there is no
 * reason to grant it `Edit`/`Write` or anything else destructive.
 */
const PLANNER_TOOLS = ["Read", "Grep", "Glob", "Bash"];

/** Root task titles are truncated to this many characters, plus an ellipsis. */
const ROOT_TITLE_MAX_LENGTH = 80;

/** A task tree can hold at most this many children — bounded on both ends. */
const MAX_PLANNED_TASKS = 12;

/**
 * Framing for the planning turn's system prompt.
 *
 * Deliberately NOT a roster row: the planner is Paco's own machinery, not a
 * subagent an org can edit or disable, so it is assembled inline and folded
 * into `customInstructions` rather than registered under `--agents`, which
 * would make it invocable as a delegate rather than the turn's own voice.
 */
const PLANNER_AGENT_DEFINITION: ClaudeAgentDefinition = {
  description:
    "Decomposes a goal into an executable task tree, reading the repository read-only.",
  prompt:
    "You are a planning agent. Explore the repository as needed — read-only — to understand what decomposing this goal actually requires, then return the task tree as the structured output described below. Do not modify any files, and do not implement anything yourself.",
};

/**
 * The exact JSON Schema the planning turn's output is constrained to
 * (`--json-schema`).
 *
 * `maxItems: 12` bounds what the model is asked for; `parsePlannerOutput`
 * still re-checks and truncates defensively, since a schema hint is not a
 * hard guarantee across every backend/CLI version.
 */
const PLANNER_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      maxItems: MAX_PLANNED_TASKS,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          goal: { type: "string" },
          assignedAgent: { type: ["string", "null"] },
        },
        required: ["title", "goal"],
      },
    },
  },
  required: ["tasks"],
};

const plannerTaskSchema = z.object({
  title: z.string(),
  goal: z.string(),
  assignedAgent: z.string().nullable().optional(),
});

const plannerOutputSchema = z.object({
  tasks: z.array(plannerTaskSchema),
});

type PlannerTask = {
  title: string;
  goal: string;
  assignedAgent: string | null;
};

/**
 * Renders the prompt a planning turn sees.
 *
 * Exported so tests can assert on it directly without re-running the whole
 * turn. `agentNames` is the caller's enabled roster (see `getRoster`) —
 * naming it in the prompt is how the model learns what delegation options
 * actually exist for this organisation, since the planner has no other way
 * to know the roster.
 */
export function buildPlannerPrompt(goal: string, agentNames: string[]): string {
  const roster = agentNames.length > 0 ? agentNames.join(", ") : "none";
  return [
    goal,
    "",
    `Decompose this goal into 2-${MAX_PLANNED_TASKS} independent, individually-completable tasks.`,
    "Each task's goal must be self-contained: the executor that runs it sees only its own goal text, never this prompt or any other task's goal.",
    `For each task, name an assignedAgent from: ${roster} — or null if none of them fit.`,
  ].join("\n");
}

/** Truncates a goal into a root task title, matching the 80-char chat-title convention. */
function truncateTitle(goal: string): string {
  return goal.length > ROOT_TITLE_MAX_LENGTH
    ? `${goal.slice(0, ROOT_TITLE_MAX_LENGTH)}...`
    : goal;
}

/**
 * Parses and defensively normalizes the planning turn's structured output.
 *
 * Returns `undefined` for anything that doesn't parse as `{tasks: [...]}` at
 * all (zero tasks is a separate, valid-shape case the caller checks itself —
 * an empty array is not malformed, just not useful). `assignedAgent` values
 * outside the enabled roster are nulled rather than rejected: a task with no
 * delegate still runs, just on the orchestrator's default agent, so this is
 * strictly more useful than failing the whole plan over one bad name.
 */
function parsePlannerOutput(
  raw: unknown,
  rosterNames: ReadonlySet<string>,
): { tasks: PlannerTask[] } | { error: string } {
  const parsed = plannerOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      error: `Planner returned malformed output: ${parsed.error.message}`,
    };
  }

  let tasks: PlannerTask[] = parsed.data.tasks.map((task) => ({
    title: task.title,
    goal: task.goal,
    assignedAgent: task.assignedAgent ?? null,
  }));

  if (tasks.length > MAX_PLANNED_TASKS) {
    console.warn(
      `planGoal: model returned ${tasks.length} tasks, truncating to ${MAX_PLANNED_TASKS}`,
    );
    tasks = tasks.slice(0, MAX_PLANNED_TASKS);
  }

  tasks = tasks.map((task) => {
    if (task.assignedAgent && !rosterNames.has(task.assignedAgent)) {
      console.warn(
        `planGoal: assignedAgent "${task.assignedAgent}" is not in the enabled roster, clearing it`,
      );
      return { ...task, assignedAgent: null };
    }
    return task;
  });

  return { tasks };
}

export type PlanGoalParams = {
  organizationId: string;
  sessionId: string;
  goal: string;
  createdBy?: string;
};

export type PlanGoalResult =
  | { ok: true; rootTaskId: string; taskIds: string[] }
  | { ok: false; error: string };

/**
 * Decomposes a goal into a task tree: one grouping root task plus its
 * planner-authored children.
 *
 * Runs exactly one headless, structured-output turn (`runAgentTurn`)
 * against the SESSION repository — not a chat's worktree, since nothing has
 * started yet and the planner only reads. The turn's own agent framing is
 * inline (`PLANNER_AGENT_DEFINITION`), not a roster row: the planner is
 * Paco's own machinery, never something an org edits or delegates to.
 *
 * Nothing is persisted unless the model's output parses to at least one
 * task — a malformed or empty response means the caller gets `{ok:false}`
 * with no partial task tree left behind to clean up.
 */
export async function planGoal(
  params: PlanGoalParams,
): Promise<PlanGoalResult> {
  const session = await getSessionById(params.sessionId);
  if (!session?.sandboxState) {
    return {
      ok: false,
      error: `Session "${params.sessionId}" has no sandbox to plan against`,
    };
  }

  const sessionRepoDir = resolveWorkCwd(session.sandboxState);
  const roster = await getRoster(params.organizationId);
  const rosterNames = Object.keys(roster);

  const prompt = buildPlannerPrompt(params.goal, rosterNames);
  const customInstructions = `${PLANNER_AGENT_DEFINITION.description}\n\n${PLANNER_AGENT_DEFINITION.prompt}`;

  const step = await runAgentTurn<UIMessage>({
    prompt,
    options: {
      sandbox: {
        state: session.sandboxState,
        workingDirectory: sessionRepoDir,
        hostWorkingDirectory: sessionRepoDir,
      },
      customInstructions,
      structuredOutput: { jsonSchema: PLANNER_JSON_SCHEMA },
      tools: PLANNER_TOOLS,
    },
    messageId: nanoid(),
    originalMessages: [],
    maxTurns: 20,
    onChunk: async () => {
      // Headless: no client is streaming this turn.
    },
  });

  const parsed = parsePlannerOutput(
    step.structuredOutput,
    new Set(rosterNames),
  );
  if ("error" in parsed) {
    return { ok: false, error: parsed.error };
  }
  if (parsed.tasks.length === 0) {
    return { ok: false, error: "Planner returned zero tasks" };
  }

  const root = await createTask({
    organizationId: params.organizationId,
    sessionId: params.sessionId,
    title: truncateTitle(params.goal),
    goal: params.goal,
    origin: "planner",
    createdBy: params.createdBy,
  });

  const taskIds: string[] = [];
  for (const task of parsed.tasks) {
    const child = await createTask({
      organizationId: params.organizationId,
      sessionId: params.sessionId,
      parentTaskId: root.id,
      title: task.title,
      goal: task.goal,
      assignedAgent: task.assignedAgent,
      origin: "planner",
      createdBy: params.createdBy,
    });
    taskIds.push(child.id);
  }

  return { ok: true, rootTaskId: root.id, taskIds };
}
