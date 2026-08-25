import { z } from "zod";

/**
 * What the design panel is allowed to ask the server to do.
 *
 * Separate from `design-actions.ts` because a `"use server"` module may only
 * export async functions — a schema or a type exported from there is a build
 * error, not a lint nit.
 *
 * The candidate index is pinned to 1..3 rather than "a positive number":
 * `lib/design/candidates.ts` names branches `design/<chatId>/<n>` for
 * exactly those, and a request arriving over the wire is the one place that
 * bound is not already guaranteed by a TypeScript literal type.
 */
export const designCandidateIndexSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

export type DesignCandidateIndex = z.infer<typeof designCandidateIndexSchema>;

export const designChatTargetSchema = z.object({
  sessionId: z.string().min(1),
  chatId: z.string().min(1),
});

export type DesignChatTarget = z.infer<typeof designChatTargetSchema>;

export const acceptDesignInputSchema = designChatTargetSchema.extend({
  index: designCandidateIndexSchema,
});

export type AcceptDesignInput = z.infer<typeof acceptDesignInputSchema>;
