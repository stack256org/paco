"use server";

import { and, eq } from "drizzle-orm";
import {
  agentDefinitionSchema,
  type AgentDefinition,
} from "@/lib/agent/agent-definition-schema";
import { requireAdmin } from "@/lib/admin/require-admin";
import { db } from "@/lib/db/client";
import {
  deleteRosterAgent,
  setRosterAgentEnabled,
  upsertRosterAgent,
} from "@/lib/db/roster";
import { rosterAgents } from "@/lib/db/schema";
import { getOrganization } from "@/lib/org/organization";

/**
 * Mirrors `ROSTER_NAME_PATTERN` in `lib/db/roster.ts`.
 *
 * That constant is private to its module, and this file is not allowed to
 * change `roster.ts` (a different task owns it), so the pattern is
 * duplicated here for a fast, field-level error message. `upsertRosterAgent`
 * re-checks the same rule server-side regardless — this copy only decides
 * which input box gets blamed, never whether the write is allowed.
 */
const ROSTER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** One roster row, with the metadata the admin-only list view needs. */
export interface RosterAgentRow {
  id: string;
  name: string;
  builtin: boolean;
  enabled: boolean;
  definition: AgentDefinition;
  /**
   * `false` when the stored `definition` no longer parses against
   * `agentDefinitionSchema` — shown so an admin can fix it, but `definition`
   * is a placeholder in that case, never the raw unparsed value: nothing
   * downstream should mistake it for a real, safe-to-run definition.
   */
  valid: boolean;
}

const FALLBACK_DEFINITION: AgentDefinition = { description: "", prompt: "" };

function toRow(row: typeof rosterAgents.$inferSelect): RosterAgentRow {
  const parsed = agentDefinitionSchema.safeParse(row.definition);
  return {
    id: row.id,
    name: row.name,
    builtin: row.builtin,
    enabled: row.enabled,
    definition: parsed.success ? parsed.data : FALLBACK_DEFINITION,
    valid: parsed.success,
  };
}

async function requireOrganization() {
  const organization = await getOrganization();
  if (!organization) {
    throw new Error("There is no organisation yet.");
  }
  return organization;
}

/**
 * Every roster row for this organisation — enabled or not, builtin or not.
 *
 * Unlike `getRoster` (the read path a chat turn uses), this never filters
 * out a disabled row or an invalid one: the whole point of this list is for
 * an admin to see and fix what a running turn would otherwise silently skip.
 */
export async function listRosterAgents(): Promise<RosterAgentRow[]> {
  await requireAdmin();
  const organization = await requireOrganization();

  const rows = await db
    .select()
    .from(rosterAgents)
    .where(eq(rosterAgents.organizationId, organization.id));

  return rows.map(toRow).sort((a, b) => a.name.localeCompare(b.name));
}

export type SaveRosterAgentResult =
  | { success: true }
  | { success: false; error: string; fieldErrors?: Record<string, string> };

/**
 * Create a new roster agent, or replace an existing one — renaming it in the
 * same step when `name` differs from `originalName`.
 *
 * `originalName` is `null` for a brand-new agent. Every failure here comes
 * back as a value, never a throw: the admin gate is the one thing this
 * action still lets fail loudly, matching every other admin action in this
 * codebase (see `instance-settings-actions.ts`), because an admin check that
 * silently returned `{ success: false }` would look, to a broken caller,
 * exactly like a validation error rather than a security boundary.
 */
export async function saveRosterAgent(input: {
  originalName: string | null;
  name: string;
  definition: unknown;
}): Promise<SaveRosterAgentResult> {
  await requireAdmin();
  const organization = await requireOrganization();
  const { originalName, name, definition } = input;

  if (!ROSTER_NAME_PATTERN.test(name)) {
    return {
      success: false,
      error: "That name is not valid.",
      fieldErrors: {
        name: "Use lowercase letters, numbers, and hyphens, starting with a letter (up to 32 characters).",
      },
    };
  }

  const parsedDefinition = agentDefinitionSchema.safeParse(definition);
  if (!parsedDefinition.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsedDefinition.error.issues) {
      const field = issue.path[0];
      if (typeof field === "string" && !(field in fieldErrors)) {
        fieldErrors[field] = issue.message;
      }
    }
    return {
      success: false,
      error:
        parsedDefinition.error.issues[0]?.message ??
        "That definition is not valid.",
      fieldErrors,
    };
  }

  const [existingByOriginalName] = originalName
    ? await db
        .select({ builtin: rosterAgents.builtin })
        .from(rosterAgents)
        .where(
          and(
            eq(rosterAgents.organizationId, organization.id),
            eq(rosterAgents.name, originalName),
          ),
        )
    : [];

  if (originalName && !existingByOriginalName) {
    return {
      success: false,
      error: `No roster agent named "${originalName}".`,
    };
  }

  const renaming = originalName !== null && originalName !== name;

  if (renaming && existingByOriginalName?.builtin) {
    return {
      success: false,
      error: "Builtin agents cannot be renamed.",
      fieldErrors: { name: "Builtin agents cannot be renamed." },
    };
  }

  // A brand-new agent or a rename both land on a name nothing should already
  // own — `upsertRosterAgent` would otherwise silently overwrite whatever is
  // already sitting at that name, builtin included.
  if (originalName === null || renaming) {
    const [collision] = await db
      .select({ id: rosterAgents.id })
      .from(rosterAgents)
      .where(
        and(
          eq(rosterAgents.organizationId, organization.id),
          eq(rosterAgents.name, name),
        ),
      );
    if (collision) {
      const message = `An agent named "${name}" already exists.`;
      return { success: false, error: message, fieldErrors: { name: message } };
    }
  }

  const result = await upsertRosterAgent(
    organization.id,
    name,
    parsedDefinition.data,
  );
  if (!result.ok) {
    return { success: false, error: result.error };
  }

  if (renaming && originalName) {
    await deleteRosterAgent(organization.id, originalName);
  }

  return { success: true };
}

/** Remove one roster agent — refused for a builtin row (see `deleteRosterAgent`). */
export async function deleteRoster(
  name: string,
): Promise<{ success: boolean; error?: string }> {
  await requireAdmin();
  const organization = await requireOrganization();

  const result = await deleteRosterAgent(organization.id, name);
  return result.ok
    ? { success: true }
    : { success: false, error: result.error };
}

/** Enable or disable a roster agent without touching its definition. */
export async function setRosterEnabled(
  name: string,
  enabled: boolean,
): Promise<{ success: boolean }> {
  await requireAdmin();
  const organization = await requireOrganization();

  await setRosterAgentEnabled(organization.id, name, enabled);
  return { success: true };
}
