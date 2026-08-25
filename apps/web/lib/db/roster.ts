import "server-only";

import { DEFAULT_AGENTS, type ClaudeAgentDefinition } from "@paco/claude-code";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { agentDefinitionSchema } from "@/lib/agent/agent-definition-schema";
import { db } from "@/lib/db/client";
import { rosterAgents } from "@/lib/db/schema";

/**
 * The `--agents` key an organisation's roster row becomes.
 *
 * Lowercase and hyphenated, matching the identifiers `DEFAULT_AGENTS` already
 * uses (`explorer`, `executor`), so a name can never contain anything a shell
 * argument or JSON key would need escaping for.
 */
const ROSTER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

function isValidRosterName(name: string): boolean {
  return ROSTER_NAME_PATTERN.test(name);
}

/**
 * The columns that make a roster row unique: one name per organisation.
 *
 * Passed to every `onConflict*` call below so idempotence comes from the
 * database's unique index (`roster_agents_org_name_idx`), not from a
 * check-then-write race that two concurrent callers could both pass.
 */
const ROSTER_ORG_NAME_TARGET = [rosterAgents.organizationId, rosterAgents.name];

/**
 * The four agents every organisation starts with.
 *
 * `explorer` and `executor` are copied verbatim from `@paco/claude-code`'s
 * `DEFAULT_AGENTS` — that remains the source of truth for what ships with
 * the CLI integration itself. `reviewer` and `designer` exist only here:
 * they are Paco-specific roles with no equivalent in a bare `claude` run.
 */
export const DEFAULT_ROSTER: Record<string, ClaudeAgentDefinition> = {
  ...DEFAULT_AGENTS,
  reviewer: {
    description:
      "Verifies completed implementation work against what was asked before it reaches the user: correctness, scope fidelity, and test evidence.",
    prompt:
      "You are a reviewer agent. You are given what was requested and what was done. Verify the work: read the changed files, run the stated tests if cheap, and check that exactly what was asked was delivered — no more, no less. Report PASS or FAIL with a concise list of specific problems and file:line references. Do not fix anything yourself.",
    model: "sonnet",
    tools: ["Read", "Grep", "Glob", "Bash"],
  },
  designer: {
    description:
      "UI and visual design work: layouts, components, styling, design-system-consistent screens.",
    prompt:
      "You are a designer agent. Read the project's design skills (look for .agents/skills/ and any SKILL.md files the environment lists) before writing any markup. Produce polished, design-system-consistent UI. Prefer editing real components over mockups. State the design decisions you made and why.",
    model: "sonnet",
  },
};

/**
 * An organisation's enabled, valid roster, ready to pass as `--agents`.
 *
 * Every row is re-validated on read, not just on write — the column is
 * JSONB, so a row from before a schema tightening or written by something
 * other than `upsertRosterAgent` is not guaranteed to still be valid. An
 * invalid row is logged and skipped rather than thrown: one bad row must
 * never turn into a fatal error for every turn in the organisation (roster
 * safety invariant).
 *
 * Seeds lazily when the organisation has zero rows, so an existing dev
 * database — created before this table existed — gets a working roster on
 * first read instead of an empty one. Safe under concurrent callers: two
 * `getRoster` calls racing on an empty org both call `seedDefaultRoster`,
 * which resolves the collision through the database's unique index rather
 * than throwing (see there), so both re-reads see the seeded rows.
 */
export async function getRoster(
  organizationId: string,
): Promise<Record<string, ClaudeAgentDefinition>> {
  let rows = await db
    .select()
    .from(rosterAgents)
    .where(eq(rosterAgents.organizationId, organizationId));

  if (rows.length === 0) {
    await seedDefaultRoster(organizationId);
    rows = await db
      .select()
      .from(rosterAgents)
      .where(eq(rosterAgents.organizationId, organizationId));
  }

  const roster: Record<string, ClaudeAgentDefinition> = {};
  for (const row of rows) {
    if (!row.enabled) {
      continue;
    }
    const parsed = agentDefinitionSchema.safeParse(row.definition);
    if (!parsed.success) {
      console.error("roster: invalid agent definition, skipping", {
        organizationId,
        name: row.name,
        error: parsed.error.message,
      });
      continue;
    }
    roster[row.name] = parsed.data;
  }
  return roster;
}

/**
 * Create or replace one roster agent, validating the definition first.
 *
 * Validation happens before any database call — an invalid definition never
 * reaches a row, builtin or not. The write itself is a single
 * `INSERT ... ON CONFLICT DO UPDATE`, not a select-then-branch: two
 * concurrent upserts of the same (org, name) would otherwise both see "no
 * existing row" and both try to insert, and the loser would crash instead of
 * updating. `builtin` is deliberately absent from the conflict's `set` — an
 * upsert can change what a builtin row does, but never turn it into a
 * deletable one.
 */
export async function upsertRosterAgent(
  organizationId: string,
  name: string,
  definition: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isValidRosterName(name)) {
    return {
      ok: false,
      error: `Invalid agent name: "${name}" must match ${ROSTER_NAME_PATTERN}`,
    };
  }

  const parsed = agentDefinitionSchema.safeParse(definition);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message };
  }

  await db
    .insert(rosterAgents)
    .values({
      id: nanoid(),
      organizationId,
      name,
      definition: parsed.data,
      builtin: false,
      enabled: true,
    })
    .onConflictDoUpdate({
      target: ROSTER_ORG_NAME_TARGET,
      set: { definition: parsed.data, updatedAt: new Date() },
    });

  return { ok: true };
}

/**
 * Remove one roster agent — refused for a builtin row.
 *
 * Builtin rows stay editable (`upsertRosterAgent` does not check `builtin`)
 * but never deletable, so an organisation can always recover a working
 * roster by resetting a builtin agent's definition instead of needing to
 * reconstruct it from nothing.
 */
export async function deleteRosterAgent(
  organizationId: string,
  name: string,
): Promise<{ ok: boolean; error?: string }> {
  const [row] = await db
    .select({ id: rosterAgents.id, builtin: rosterAgents.builtin })
    .from(rosterAgents)
    .where(
      and(
        eq(rosterAgents.organizationId, organizationId),
        eq(rosterAgents.name, name),
      ),
    );

  if (!row) {
    return { ok: false, error: `No roster agent named "${name}"` };
  }
  if (row.builtin) {
    return { ok: false, error: "Builtin agents cannot be deleted" };
  }

  await db.delete(rosterAgents).where(eq(rosterAgents.id, row.id));
  return { ok: true };
}

/** Enable or disable a roster agent without changing its definition. */
export async function setRosterAgentEnabled(
  organizationId: string,
  name: string,
  enabled: boolean,
): Promise<void> {
  await db
    .update(rosterAgents)
    .set({ enabled, updatedAt: new Date() })
    .where(
      and(
        eq(rosterAgents.organizationId, organizationId),
        eq(rosterAgents.name, name),
      ),
    );
}

/**
 * Insert whichever `DEFAULT_ROSTER` agents an organisation is missing.
 *
 * Idempotent by database constraint, not by a preceding read: the insert
 * carries all four defaults every time and relies on
 * `roster_agents_org_name_idx` plus `onConflictDoNothing` to silently drop
 * whichever rows already exist. A select-then-filter-then-insert version of
 * this raced two concurrent callers (both organisation creation and
 * `getRoster`'s lazy path can call this) — both would see zero existing rows
 * and both attempt to insert all four, and the second insert would crash on
 * the unique index instead of no-op'ing. `ON CONFLICT DO NOTHING` in a
 * multi-row insert applies per row, so a partially-seeded org (some rows
 * present, some missing) still gets exactly the missing ones inserted.
 *
 * Never overwrites a row a user has already edited or removed, builtin or
 * not — a conflict is dropped, not merged.
 */
export async function seedDefaultRoster(organizationId: string): Promise<void> {
  const now = new Date();
  await db
    .insert(rosterAgents)
    .values(
      Object.entries(DEFAULT_ROSTER).map(([name, definition]) => ({
        id: nanoid(),
        organizationId,
        name,
        definition,
        builtin: true,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing({ target: ROSTER_ORG_NAME_TARGET });
}
