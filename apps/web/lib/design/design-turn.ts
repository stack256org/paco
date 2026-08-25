import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ClaudeAgentDefinition } from "@paco/claude-code";
import type { UIMessageChunk } from "ai";
import { candidateContainerPort } from "@/lib/preview/nginx-config";
import type { AgentCallOptions } from "@/lib/agent/types";
import type { DesignCandidate } from "./candidates";

const execFileAsync = promisify(execFile);

/**
 * Upper bound on a design candidate turn's own agentic loop (`--max-turns`).
 *
 * Lower than a normal chat turn's cap (500, `submit-message.ts`'s
 * `DEFAULT_MAX_STEPS`): a candidate is one focused pass at one visual
 * direction, run N times in parallel, not an open-ended session — and
 * three candidates each burning 500 turns would be an expensive way to
 * find out one of them looped.
 */
export const DESIGN_CANDIDATE_MAX_TURNS = 40;

/** How many candidates a design turn runs when the caller doesn't say. */
export const DEFAULT_DESIGN_CANDIDATE_COUNT: 2 | 3 = 3;

/**
 * Fallback designer persona for a design turn.
 *
 * Mirrors `DEFAULT_ROSTER.designer` in `lib/db/roster.ts` verbatim, but
 * duplicated rather than imported: that module's default export chain pulls
 * in `@/lib/db/client` (a live Postgres client) at the top level purely to
 * seed an organisation's roster on first read, which a design turn should
 * never have to load just to pick a default persona when the org's own
 * roster can't be resolved (see `resolveChatAgents`'s own doc: `getRoster`
 * self-heals a missing `designer` row, so this fallback exists for the
 * resolution call itself failing, not for the row being unseeded).
 */
export const FALLBACK_DESIGNER_AGENT: ClaudeAgentDefinition = {
  description:
    "UI and visual design work: layouts, components, styling, design-system-consistent screens.",
  prompt:
    "You are a designer agent. Read the project's design skills (look for .agents/skills/ and any SKILL.md files the environment lists) before writing any markup. Produce polished, design-system-consistent UI. Prefer editing real components over mockups. State the design decisions you made and why.",
  model: "sonnet",
};

export type DesignCandidateProgressStatus =
  | "running"
  | "committing"
  | "completed"
  | "failed";

/** One candidate's progress, streamed live as a `data-design-progress` part. */
export interface DesignProgress {
  candidate: number;
  status: DesignCandidateProgressStatus;
  error?: string;
}

/** Where one candidate ended up once its turn (and auto-commit) finished. */
export interface DesignCandidateOutcome {
  index: number;
  branch: string;
  worktreeDir: string;
  status: "completed" | "failed";
  /** Whether the auto-commit safety net actually created a commit. */
  committed: boolean;
  error?: string;
  claudeSessionId?: string;
}

/**
 * Every design candidate failed. The design turn as a whole failed too — a
 * single candidate erroring is expected and handled (see `runDesignTurn`'s
 * doc), but zero surviving candidates leaves nothing for the design panel
 * to show.
 */
export class DesignTurnAllFailedError extends Error {
  outcomes: DesignCandidateOutcome[];

  constructor(outcomes: DesignCandidateOutcome[]) {
    const reasons = outcomes
      .map(
        (outcome) => `#${outcome.index} (${outcome.error ?? "unknown error"})`,
      )
      .join("; ");
    super(`Every design candidate failed: ${reasons}`);
    this.name = "DesignTurnAllFailedError";
    this.outcomes = outcomes;
  }
}

/** Which visual direction a candidate index is asked to take. */
const CANDIDATE_DIRECTIONS: Record<number, string> = {
  1: "closest to the existing design language",
  2: "a bolder restructure",
  3: "experimental",
};

function candidateDirection(index: number): string {
  return CANDIDATE_DIRECTIONS[index] ?? "a distinct visual direction";
}

/**
 * The per-candidate framing, verbatim per the design-mode plan (Section 5
 * Task 2): what makes candidate `index` different from its siblings, and the
 * instruction to actually build and commit real UI rather than a mockup.
 */
function buildCandidateFraming(index: number, count: number): string {
  return [
    `You are producing DESIGN CANDIDATE ${index} of ${count}. Take a distinct`,
    "visual direction from the other candidates: candidate 1 = closest to the",
    "existing design language; 2 = bolder restructure; 3 = experimental.",
    `(This candidate: ${candidateDirection(index)}.)`,
    "Implement the request as real, running UI in this worktree. Commit your",
    "work.",
  ].join(" ");
}

/**
 * The port contract from `candidateContainerPort`'s doc comment
 * (`lib/preview/nginx-config.ts`), restated as an instruction the candidate's
 * own turn can act on.
 *
 * That comment names this file as "whoever wires up the design turn" and
 * spells out exactly what happens if it's skipped: `collectActivePreviewRoutes`
 * finds the candidate's worktree but never a published port for it, and the
 * candidate silently shows as unreachable with no error anywhere. Restating
 * the contract here, in the one prompt that actually reaches the process
 * that starts the dev server, is the whole enforcement mechanism — nothing
 * downstream can detect "bound the wrong port" from the outside.
 */
function buildPortContractInstruction(index: 1 | 2 | 3): string {
  const port = candidateContainerPort(index);
  return [
    `## Preview port for this candidate`,
    "",
    `Your dev server for THIS candidate MUST bind port ${port} — not the`,
    "framework's default, and not 3000 (that port belongs to the chat's own",
    `preview; binding it collides). Pass \`PORT=${port}\` (Next.js/Express/`,
    "Remix) or the framework's own `--port` flag. Start it inside the sandbox",
    "container, the same way the chat's own dev server is started — a server",
    "started on the host is not reachable through the published preview.",
    "",
    "If it binds the wrong port, this candidate's preview will never appear,",
    "with no error surfaced anywhere.",
  ].join("\n");
}

/**
 * Everything a candidate turn's own system prompt needs beyond the base
 * agent options: the designer's persona (so the top-level turn behaves as
 * the designer roster agent, not the default orchestrator), which candidate
 * it is and how it should differ from its siblings, and the preview-port
 * contract.
 */
function buildCandidateCustomInstructions(params: {
  designerPrompt: string;
  index: number;
  count: number;
  baseCustomInstructions?: string;
}): string {
  return [
    params.designerPrompt,
    buildCandidateFraming(params.index, params.count),
    buildPortContractInstruction(params.index as 1 | 2 | 3),
    ...(params.baseCustomInstructions ? [params.baseCustomInstructions] : []),
  ].join("\n\n");
}

async function runGit(
  args: string[],
  cwd: string,
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd });
    return { success: true, stdout, stderr };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string } & Error;
    return {
      success: false,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? String(error),
    };
  }
}

function gitOutput(result: { stdout: string; stderr: string }): string {
  return result.stderr.trim() || result.stdout.trim() || "git command failed";
}

export interface CandidateCommitResult {
  committed: boolean;
  error?: string;
}

/**
 * Auto-commit a design candidate's worktree when it is dirty.
 *
 * The candidate's own system-prompt framing tells it to commit its work
 * (`buildCandidateFraming`), but nothing enforces that — a turn that produced
 * real, running UI and then never got around to (or ran out of turns before)
 * `git commit` would otherwise leave the work uncommitted and unreachable
 * through `acceptCandidate`'s merge (Task 1) once candidates are cleaned up.
 * This is that safety net, run after every candidate turn regardless of
 * whether the turn itself succeeded — mirroring `createCheckpoint`'s "never
 * let the safety net become a reason the turn fails" posture
 * (`lib/git/checkpoint.ts`): failures here are reported, never thrown.
 *
 * Unlike a chat's checkpoint (a commit object under a private ref, HEAD left
 * untouched, because a chat's branch has other history to keep separate from
 * it), this commits for real, onto the candidate's own branch — a design
 * candidate branch has no other history to protect, and `acceptCandidate`
 * needs an actual commit to merge.
 *
 * Runs git directly against the host filesystem rather than through a
 * `Sandbox`, the same way `candidates.ts`'s own `git()` helper does: a
 * design worktree lives at the same absolute path on the host and inside
 * the sandbox container, so there is nothing to route through.
 */
export async function commitCandidateIfDirty(
  worktreeDir: string,
  index: number,
): Promise<CandidateCommitResult> {
  const status = await runGit(["status", "--porcelain"], worktreeDir);
  if (!status.success) {
    return {
      committed: false,
      error: `Could not check design candidate ${index}'s worktree for changes: ${gitOutput(status)}`,
    };
  }
  if (status.stdout.trim().length === 0) {
    return { committed: false };
  }

  const added = await runGit(["add", "-A"], worktreeDir);
  if (!added.success) {
    return {
      committed: false,
      error: `Could not stage design candidate ${index}'s changes: ${gitOutput(added)}`,
    };
  }

  const committed = await runGit(
    ["commit", "-m", `Design candidate ${index}`],
    worktreeDir,
  );
  if (!committed.success) {
    return {
      committed: false,
      error: `Could not commit design candidate ${index}'s changes: ${gitOutput(committed)}`,
    };
  }

  return { committed: true };
}

interface CandidateTurnResult {
  isError: boolean;
  finishReason: string;
  claudeSessionId?: string;
}

/**
 * The slice of `runAgentTurn`'s contract a design candidate actually needs.
 *
 * Narrower than `typeof runAgentTurn` on purpose: that function is generic
 * over the caller's `UIMessage` shape and carries persistence concerns (an
 * `originalMessages` list to reconcile a continuing message against) that a
 * design candidate — a turn with no prior history, run once per candidate —
 * has no use for. Tests inject a fake matching this instead of fighting the
 * generic.
 */
export type RunCandidateTurn = (params: {
  prompt: string;
  options: AgentCallOptions;
  messageId: string;
  maxTurns: number;
  onChunk: (chunk: UIMessageChunk) => Promise<void>;
}) => Promise<CandidateTurnResult>;

async function defaultRunCandidateTurn(
  params: Parameters<RunCandidateTurn>[0],
): Promise<CandidateTurnResult> {
  const { runAgentTurn } = await import("@/lib/agent/run-step");
  const result = await runAgentTurn({
    prompt: params.prompt,
    options: params.options,
    messageId: params.messageId,
    originalMessages: [],
    maxTurns: params.maxTurns,
    onChunk: params.onChunk,
  });
  return {
    isError: result.isError,
    finishReason: result.finishReason,
    ...(result.claudeSessionId
      ? { claudeSessionId: result.claudeSessionId }
      : {}),
  };
}

export interface RunDesignTurnParams {
  candidates: DesignCandidate[];
  /** The user's design request, sent as-is to every candidate. */
  prompt: string;
  /** Base options for every candidate turn; `sandbox` is overridden per candidate. */
  agentOptions: AgentCallOptions;
  /** The designer roster agent, whose persona frames every candidate's turn. */
  designerAgent: ClaudeAgentDefinition;
  onProgress: (progress: DesignProgress) => Promise<void>;
  onChunk: (candidateIndex: number, chunk: UIMessageChunk) => Promise<void>;
  /** Injectable for tests; defaults to the real `runAgentTurn`. */
  runTurn?: RunCandidateTurn;
  /** Injectable for tests; defaults to the real `commitCandidateIfDirty`. */
  commitCandidate?: (
    worktreeDir: string,
    index: number,
  ) => Promise<CandidateCommitResult>;
}

export interface RunDesignTurnResult {
  outcomes: DesignCandidateOutcome[];
}

/**
 * Run a design turn's N parallel candidate variants.
 *
 * Each candidate is `runTurn`ed independently in its own worktree, then
 * auto-committed if it left the worktree dirty. Candidates run fully in
 * parallel (`Promise.all` over per-candidate work that never rejects — every
 * failure is caught and folded into that candidate's outcome instead) so one
 * candidate's turn failing can never abort another's, or leave it half
 * awaited.
 *
 * A failed candidate does not fail the design turn: it is reported via
 * `onProgress` and excluded from anything that treats outcomes as "what to
 * show." The design turn only fails — by throwing `DesignTurnAllFailedError`
 * — when every candidate failed, since a design turn with zero surviving
 * candidates has nothing left to hand back.
 */
export async function runDesignTurn(
  params: RunDesignTurnParams,
): Promise<RunDesignTurnResult> {
  const runTurn = params.runTurn ?? defaultRunCandidateTurn;
  const commitCandidate = params.commitCandidate ?? commitCandidateIfDirty;
  const count = params.candidates.length;

  const outcomes = await Promise.all(
    params.candidates.map(
      async (candidate): Promise<DesignCandidateOutcome> => {
        await params.onProgress({
          candidate: candidate.index,
          status: "running",
        });

        let turnError: string | undefined;
        let claudeSessionId: string | undefined;

        const candidateEffort =
          params.designerAgent.effort ?? params.agentOptions.model?.effort;

        try {
          const result = await runTurn({
            prompt: params.prompt,
            options: {
              ...params.agentOptions,
              customInstructions: buildCandidateCustomInstructions({
                designerPrompt: params.designerAgent.prompt,
                index: candidate.index,
                count,
                baseCustomInstructions: params.agentOptions.customInstructions,
              }),
              sandbox: {
                ...params.agentOptions.sandbox,
                workingDirectory: candidate.worktreeDir,
                hostWorkingDirectory: candidate.worktreeDir,
                currentBranch: candidate.branch,
              },
              model: {
                id:
                  params.designerAgent.model ??
                  params.agentOptions.model?.id ??
                  "sonnet",
                ...(candidateEffort ? { effort: candidateEffort } : {}),
              },
            },
            messageId: `design-candidate-${candidate.index}`,
            maxTurns: DESIGN_CANDIDATE_MAX_TURNS,
            onChunk: (chunk) => params.onChunk(candidate.index, chunk),
          });

          claudeSessionId = result.claudeSessionId;
          if (result.isError) {
            turnError = `Design candidate ${candidate.index} ended in error (finish reason: ${result.finishReason}).`;
          }
        } catch (error) {
          turnError = error instanceof Error ? error.message : String(error);
        }

        await params.onProgress({
          candidate: candidate.index,
          status: "committing",
        });
        const commitResult = await commitCandidate(
          candidate.worktreeDir,
          candidate.index,
        );

        // A failed auto-commit never overrides a turn that already failed,
        // and never turns a successful turn into a failed one by itself —
        // losing the commit is a smaller problem than losing the candidate —
        // but it is always reported.
        const combinedError = turnError ?? commitResult.error;
        const status: "completed" | "failed" = turnError
          ? "failed"
          : "completed";

        await params.onProgress({
          candidate: candidate.index,
          status,
          ...(combinedError ? { error: combinedError } : {}),
        });

        return {
          index: candidate.index,
          branch: candidate.branch,
          worktreeDir: candidate.worktreeDir,
          status,
          committed: commitResult.committed,
          ...(combinedError ? { error: combinedError } : {}),
          ...(claudeSessionId ? { claudeSessionId } : {}),
        };
      },
    ),
  );

  const anySucceeded = outcomes.some(
    (outcome) => outcome.status === "completed",
  );
  if (!anySucceeded) {
    throw new DesignTurnAllFailedError(outcomes);
  }

  return { outcomes };
}
