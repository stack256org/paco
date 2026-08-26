import { z } from "zod";

/**
 * The shape the Source Control panel speaks.
 *
 * Separate from `source-control-actions.ts` because a `"use server"` module may
 * only export async functions — a schema or a type exported from there is a
 * build error, not a lint nit.
 */

/**
 * One changed path, as git reports it.
 *
 * The letters are git's own porcelain codes, narrowed to the six that can
 * reach a person: modified, added, deleted, renamed, copied, unmerged. Git's
 * seventh, `T` (a file that became a symlink, or stopped being one), is folded
 * into `M`: it is a content change to everyone except git.
 */
export type FileChangeStatus = "M" | "A" | "D" | "R" | "C" | "U";

export type FileChange = {
  path: string;
  status: FileChangeStatus;
  /** Where a rename or copy came from. Absent for everything else. */
  oldPath?: string;
};

export type WorkingTreeStatus = {
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: FileChange[];
  /**
   * Commits on this chat's branch that the base branch does not have — the
   * operator's own commits, since turns no longer make any.
   */
  aheadOfBase: number;
};

export type SourceControlResult = { success: boolean; error?: string };

export type CommitResult = {
  success: boolean;
  sha?: string;
  error?: string;
};

export type FileDiff = {
  /**
   * A complete unified diff, headers included (`diff --git`, `---`, `+++`), so
   * it can be handed straight to a patch renderer. Empty when `binary`.
   */
  patch: string;
  binary: boolean;
  oldPath?: string;
};

/**
 * A path the browser sent.
 *
 * Repo-relative, so an absolute path, a traversal, or anything reaching into
 * `.git` is refused before it is spliced into a git command. `shellQuote`
 * already stops a path from *executing*, but nothing else stops one from
 * naming a file outside the worktree.
 */
export const repoRelativePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !(value.startsWith("/") || value.includes("\0")), {
    message: "That path is not inside this workspace.",
  })
  .refine(
    (value) =>
      value
        .split("/")
        .every(
          (segment) =>
            segment !== "" &&
            segment !== "." &&
            segment !== ".." &&
            segment !== ".git",
        ),
    { message: "That path is not inside this workspace." },
  );

export const chatIdSchema = z.string().min(1).max(128);

export const pathListSchema = z.array(repoRelativePathSchema).min(1).max(2000);

/**
 * A commit message that is actually a message.
 *
 * Refusing an empty one is not pedantry: `git commit` with an empty message
 * aborts anyway, and the operator would see git's abort text rather than
 * something they can act on. Trimmed first, so a message of three spaces is
 * refused for the same reason and with the same words.
 */
export const commitMessageSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, {
    message: "Write a commit message before committing.",
  })
  .refine((value) => value.length <= 20_000, {
    message: "That commit message is too long.",
  });

export const fileDiffOptionsSchema = z.object({ staged: z.boolean() });

export type FileDiffOptions = z.infer<typeof fileDiffOptionsSchema>;
