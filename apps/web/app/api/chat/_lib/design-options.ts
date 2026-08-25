import { z } from "zod";
import { DEFAULT_DESIGN_CANDIDATE_COUNT } from "@/lib/design/design-turn";

/**
 * The design fields a chat send may carry.
 *
 * Design mode is per-message, not per-chat: the composer's toggle decides
 * how the *next* send runs, so it travels in the request body beside the
 * messages rather than living on the `chats` row.
 *
 * Everything here is validated rather than cast, because the workflow's own
 * guard (`app/workflows/chat.ts`) is a `throw` inside a durable run — a
 * rejected count reaching it costs a failed workflow and a red turn in the
 * transcript, where rejecting it at the route costs a 400 the composer can
 * show. The workflow keeps its guard regardless; this is the cheaper of the
 * two places to find out.
 */
const chatDesignOptionsSchema = z.object({
  mode: z.literal("design").optional(),
  designCandidateCount: z.union([z.literal(2), z.literal(3)]).optional(),
  /** Refine one existing candidate in place instead of generating a fresh set. */
  designIterateCandidate: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .optional(),
});

export type ChatDesignOptions = z.infer<typeof chatDesignOptionsSchema>;

export type ParseChatDesignOptionsResult =
  | { ok: true; options: ChatDesignOptions }
  | { ok: false };

/**
 * Read the design fields off a chat request body.
 *
 * A body with no `mode: "design"` gets an empty options object even when it
 * carries stray design fields — an ordinary send is an ordinary send, and a
 * `designCandidateCount` with no design mode behind it has nothing to
 * configure.
 *
 * A design send always leaves with a candidate count, defaulted here from
 * `DEFAULT_DESIGN_CANDIDATE_COUNT`, so the workflow never has to guess and
 * the count that reaches git is one its branch-naming rule can hold.
 */
export function parseChatDesignOptions(
  body: unknown,
): ParseChatDesignOptionsResult {
  const parsed = chatDesignOptionsSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false };
  }

  if (parsed.data.mode !== "design") {
    return { ok: true, options: {} };
  }

  return {
    ok: true,
    options: {
      mode: "design",
      designCandidateCount:
        parsed.data.designCandidateCount ?? DEFAULT_DESIGN_CANDIDATE_COUNT,
      ...(parsed.data.designIterateCandidate
        ? { designIterateCandidate: parsed.data.designIterateCandidate }
        : {}),
    },
  };
}
