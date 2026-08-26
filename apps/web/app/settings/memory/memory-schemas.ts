import { z } from "zod";

/**
 * Validation for the writes this settings page can make.
 *
 * Kept out of `actions.ts` for the same reason `lib/admin/instance-settings-schemas.ts`
 * is kept out of its actions file: that module has a top-level `"use server"`
 * directive, under which every export must be an async function, so a plain
 * Zod schema cannot live there. Keeping it here also lets the schemas be
 * exercised, and the limit be quoted in the UI, without a session.
 */

/**
 * The most characters a memory entry's body may hold.
 *
 * Memory is not free-form storage: every entry in scope is concatenated into
 * the system prompt of each turn by `lib/memory/load-for-turn.ts`, so a body
 * is really prompt budget. 20k characters is roughly 5k tokens — far more
 * than any distilled note needs, and small enough that a single entry cannot
 * crowd out the conversation.
 */
export const MEMORY_BODY_MAX_LENGTH = 20_000;

/**
 * The same rule `deleteMemory` enforces in `lib/memory/store.ts` before it
 * touches the filesystem, applied one layer earlier so a malformed slug is
 * reported as a validation failure instead of being indistinguishable from
 * "no such entry".
 *
 * A slug is a filename, so this is also what keeps `..` and separators out
 * of a path join.
 */
const slugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9-]+$/, "That memory entry could not be identified.");

const bodySchema = z
  .string()
  .max(
    MEMORY_BODY_MAX_LENGTH,
    `A memory entry can be at most ${MEMORY_BODY_MAX_LENGTH.toLocaleString("en-GB")} characters.`,
  )
  // Checked on the trimmed value but stored untrimmed: a body is markdown,
  // where leading whitespace is an indented code block, so validation must
  // never rewrite it.
  .refine((value) => value.trim().length > 0, {
    message: "A memory entry can't be empty.",
  });

export const memoryEditSchema = z.object({
  slug: slugSchema,
  body: bodySchema,
});

export const memoryDeleteSchema = z.object({ slug: slugSchema });
