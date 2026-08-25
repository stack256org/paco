import "server-only";

import { DEFAULT_AGENTS } from "@paco/claude-code";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  agentDefinitionSchema,
  type AgentDefinition,
} from "@/lib/agent/agent-definition-schema";
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
 * The four agents every organisation starts with.
 *
 * `explorer` and `executor` are copied verbatim from `@paco/claude-code`'s
 * `DEFAULT_AGENTS` — that remains the source of truth for what ships with
 * the CLI integration itself. `reviewer` and `designer` exist only here:
 * they are Paco-specific roles with no equivalent in a bare `claude` run.
 */
export const DEFAULT_ROSTER: Record<string, AgentDefinition> = {
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
 * first read instead of an empty one.
 */
export async function getRoster(
  organizationId: string,
): Promise<Record<string, AgentDefinition>> {
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

  const roster: Record<string, AgentDefinition> = {};
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
 * reaches a row, builtin or not.
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

  const [existing] = await db
    .select({ id: rosterAgents.id })
    .from(rosterAgents)
    .where(
      and(
        eq(rosterAgents.organizationId, organizationId),
        eq(rosterAgents.name, name),
      ),
    );

  if (existing) {
    await db
      .update(rosterAgents)
      .set({ definition: parsed.data, updatedAt: new Date() })
      .where(eq(rosterAgents.id, existing.id));
  } else {
    await db.insert(rosterAgents).values({
      id: nanoid(),
      organizationId,
      name,
      definition: parsed.data,
      builtin: false,
      enabled: true,
    });
  }

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
 * Idempotent: called on every organisation creation (so it does something
 * exactly once for a fresh org) and lazily from `getRoster` (so it does
 * nothing for an org that already has rows). Only fills in gaps — it never
 * overwrites a row a user has already edited or removed, builtin or not.
 */
export async function seedDefaultRoster(organizationId: string): Promise<void> {
  const existing = await db
    .select({ name: rosterAgents.name })
    .from(rosterAgents)
    .where(eq(rosterAgents.organizationId, organizationId));
  const existingNames = new Set(existing.map((row) => row.name));

  const missing = Object.entries(DEFAULT_ROSTER).filter(
    ([name]) => !existingNames.has(name),
  );
  if (missing.length === 0) {
    return;
  }

  const now = new Date();
  await db.insert(rosterAgents).values(
    missing.map(([name, definition]) => ({
      id: nanoid(),
      organizationId,
      name,
      definition,
      builtin: true,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    })),
  );
}
