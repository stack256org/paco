import { z } from "zod";
import type { UnsavedWork } from "@/lib/reaping/types";
import { deleteFailureMessage } from "./delete-workspace-copy";

/**
 * The three answers `DELETE /api/sessions/[sessionId]` can give, as something
 * the UI can branch on.
 *
 * The 409 is the reason this is parsed rather than read off the body. It is not
 * an error to show and forget: it carries the counts that the second dialog is
 * built out of, and a dialog that says "3 uncommitted files" has to be sure
 * that 3 came from the server and is a number.
 *
 * Parsing is deliberately tolerant of a 409 whose `unsavedWork` is missing or
 * malformed. The refusal itself is the load-bearing fact — the delete did not
 * happen — and dropping the whole response because a field was the wrong shape
 * would turn "we stopped and asked" into "something went wrong", which is the
 * one outcome that loses work.
 */

const unsavedWorkSchema = z.object({
  uncommittedFiles: z.number().int().nonnegative(),
  unpushedCommits: z.number().int().nonnegative(),
  hasRemote: z.boolean(),
  trackedFiles: z.number().int().nonnegative(),
});

const deletedSchema = z.object({
  success: z.literal(true),
  freedBytes: z.number().nonnegative().optional(),
  warnings: z.array(z.string()).optional(),
});

const errorBodySchema = z.object({
  error: z.string().min(1).optional(),
  unsavedWork: unsavedWorkSchema.optional(),
});

/**
 * What is assumed about a workspace the server refused to describe.
 *
 * Zeros with no remote, which the copy renders as "could not read the history,
 * treat everything as unsaved" — the same thing the route's own probe means
 * when it returns null.
 */
export const UNKNOWN_UNSAVED_WORK: UnsavedWork = {
  uncommittedFiles: 0,
  unpushedCommits: 0,
  hasRemote: false,
  trackedFiles: 0,
};

export type DeleteWorkspaceOutcome =
  | { kind: "deleted"; freedBytes: number; warnings: string[] }
  /** Refused: there is work here that exists nowhere else. Ask again with force. */
  | { kind: "blocked"; unsavedWork: UnsavedWork }
  | { kind: "failed"; message: string };

export function parseDeleteWorkspaceResponse(
  status: number,
  body: unknown,
): DeleteWorkspaceOutcome {
  if (status === 409) {
    const parsed = errorBodySchema.safeParse(body);
    return {
      kind: "blocked",
      unsavedWork: parsed.success
        ? (parsed.data.unsavedWork ?? UNKNOWN_UNSAVED_WORK)
        : UNKNOWN_UNSAVED_WORK,
    };
  }

  if (status >= 200 && status < 300) {
    const parsed = deletedSchema.safeParse(body);
    if (parsed.success) {
      return {
        kind: "deleted",
        freedBytes: parsed.data.freedBytes ?? 0,
        warnings: parsed.data.warnings ?? [],
      };
    }

    // A 2xx that does not say `success: true` is not something to celebrate;
    // the row may still be there, and claiming otherwise hides the workspace
    // from the only list that could delete it again.
    return { kind: "failed", message: deleteFailureMessage(null) };
  }

  const parsed = errorBodySchema.safeParse(body);
  return {
    kind: "failed",
    message: deleteFailureMessage(
      parsed.success ? (parsed.data.error ?? null) : null,
    ),
  };
}
