import { orgMemoryDir } from "./paths";
import { writeMemory } from "./store";

/**
 * Writes an entry straight into an organisation's shared memory.
 *
 * The only writer of org memory allowed by the plan's memory invariants
 * (org memory is written ONLY by explicit promotion, never by automatic
 * distillation) — always tagged `source: "promoted"`, never `"distilled"`
 * or `"manual"`, so the settings page can tell a promoted entry apart from
 * one typed by hand.
 *
 * This module deliberately carries NO `"use server"` directive, and must
 * never gain one. Next.js turns every exported async function of a
 * `"use server"` module into a POST-able endpoint with its own action id,
 * and the id ships to the browser as soon as any client component imports
 * the module. This function takes `organizationId` as a plain argument and
 * performs no authorization of its own, so as an endpoint it would let any
 * caller write attacker-chosen content into memory that `load-for-turn.ts`
 * injects into every agent turn — a persistent prompt-injection write
 * primitive.
 *
 * The authorization lives one level up, in `promote.ts`'s
 * `promoteMemoryAction`, which is the only thing that may call this.
 */
export async function promoteToOrgMemory(params: {
  organizationId: string;
  title: string;
  body: string;
}): Promise<{ slug: string }> {
  return await writeMemory(orgMemoryDir(params.organizationId), {
    title: params.title,
    body: params.body,
    source: "promoted",
  });
}
