import "server-only";

import { generateText } from "@/lib/claude/generate";

/** Conventional-commit subject lines are meant to be short. */
const MAX_SUBJECT_LENGTH = 72;

/** Enough of a diff to describe it; more is mostly noise and cost. */
const MAX_DIFF_CHARS = 8000;

const FALLBACK = "chore: update repository changes";

/**
 * Write a commit subject from a staged diff.
 *
 * Extracted so the auto-commit path and the "generate message" button cannot
 * drift apart: they previously carried near-identical prompts in two files,
 * one of which also assembled the commit through the GitHub API.
 *
 * Falls back to a generic subject rather than failing. A commit with a dull
 * message is a far better outcome than a turn's work left uncommitted because
 * a model call timed out.
 */
export async function generateCommitMessage(
  diff: string,
  sessionTitle: string,
): Promise<string> {
  if (!diff.trim()) {
    return FALLBACK;
  }

  try {
    const result = await generateText({
      prompt: `Generate a concise git commit message for these changes. Use conventional commit format (e.g., "feat:", "fix:", "refactor:"). One line only, max ${MAX_SUBJECT_LENGTH} characters.

Session context: ${sessionTitle}

Diff:
${diff.slice(0, MAX_DIFF_CHARS)}

Respond with ONLY the commit message, nothing else.`,
    });

    const firstLine = result.text.trim().split("\n")[0]?.trim();
    return firstLine && firstLine.length > 0
      ? firstLine.slice(0, MAX_SUBJECT_LENGTH)
      : FALLBACK;
  } catch {
    return FALLBACK;
  }
}
