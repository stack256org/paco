import { z } from "zod";

/**
 * The two halves of the protocol `public/design-inspector.js` speaks.
 *
 * That file is the authority — it is injected into a candidate's own page by
 * nginx `sub_filter` and cannot import anything, so this module restates its
 * message shapes rather than sharing them. Read its header comment before
 * changing anything here: both directions are pinned to an exact origin, and
 * a mismatched `type` string simply means clicks stop arriving, with nothing
 * logged anywhere.
 */

/** Parent -> inspector: start highlighting and intercepting clicks. */
export const DESIGN_INSPECT_ARM_MESSAGE = { type: "paco-inspect-arm" } as const;

/**
 * Inspector -> parent, on every armed click.
 *
 * The inspector also sends a `rect`, which nothing here draws — so it is
 * neither declared nor validated: zod strips unknown keys, and requiring a
 * field the UI never reads would only create a way for a click to be
 * silently dropped.
 */
const inspectClickMessageSchema = z.object({
  type: z.literal("paco-inspect-click"),
  selector: z.string().min(1),
  text: z.string(),
});

export type InspectClickMessage = z.infer<typeof inspectClickMessageSchema>;

/**
 * A `message` event's `data`, if it is an inspector click — `null` otherwise.
 *
 * Origin checking is the caller's job and happens first: this only decides
 * whether a payload that already came from the right frame is one this UI
 * knows how to act on.
 */
export function parseInspectClickMessage(
  data: unknown,
): InspectClickMessage | null {
  const parsed = inspectClickMessageSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
