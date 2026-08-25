import "server-only";

import { type Capability, pluginManifestSchema } from "@paco/plugin-kit";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { plugins } from "@/lib/db/schema";

export type PluginRow = typeof plugins.$inferSelect;
export type NewPluginRow = typeof plugins.$inferInsert;

/**
 * Thrown by `setPluginGrants` when the requested grants are not a subset of
 * the capabilities the plugin's manifest declared at install time.
 *
 * Naming the failure (rather than folding it into a generic `Error`) makes
 * the "no self-escalation" invariant (spec Section 2) visible at call sites
 * and in logs, instead of looking like any other database failure.
 */
export class PluginGrantEscalationError extends Error {
  constructor(
    pluginId: string,
    requested: Capability[],
    declared: Capability[],
  ) {
    super(
      `Plugin "${pluginId}" requested grants ${JSON.stringify(
        requested,
      )} that are not a subset of its declared capabilities ${JSON.stringify(
        declared,
      )}`,
    );
    this.name = "PluginGrantEscalationError";
  }
}

/** Every installed plugin, ordered by id. */
export async function listPlugins(): Promise<PluginRow[]> {
  return await db.select().from(plugins).orderBy(asc(plugins.id));
}

export async function getPlugin(id: string): Promise<PluginRow | undefined> {
  const [row] = await db.select().from(plugins).where(eq(plugins.id, id));
  return row;
}

/**
 * Install or update a plugin row.
 *
 * `enabled` is not part of `NewPluginRow`'s required shape and defaults to
 * `false` at the schema level: installing a plugin only ever registers it,
 * never runs it (spec Section 2 consent invariant) — `setPluginEnabled` is
 * the deliberate second step.
 */
export async function upsertPlugin(row: NewPluginRow): Promise<void> {
  const existing = await getPlugin(row.id);
  const updatedAt = new Date();

  if (existing) {
    await db
      .update(plugins)
      .set({ ...row, updatedAt })
      .where(eq(plugins.id, row.id));
  } else {
    await db.insert(plugins).values({ ...row, updatedAt });
  }
}

export async function setPluginEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  await db
    .update(plugins)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(plugins.id, id));
}

/**
 * Replace a plugin's granted capabilities, enforcing that the request never
 * exceeds what its manifest declared.
 *
 * A plugin cannot grant itself more than it asked for at install time — that
 * is the whole point of a manifest declaring capabilities up front. When the
 * stored manifest fails to parse, `declared` is treated as empty rather than
 * skipped, so a corrupted or tampered row denies every grant instead of
 * silently allowing one.
 */
export async function setPluginGrants(
  id: string,
  grants: Capability[],
): Promise<void> {
  const row = await getPlugin(id);
  if (!row) {
    throw new Error(`No plugin installed with id "${id}"`);
  }

  const parsedManifest = pluginManifestSchema.safeParse(row.manifest);
  const declared: Capability[] = parsedManifest.success
    ? parsedManifest.data.capabilities
    : [];

  const isSubset = grants.every((grant) => declared.includes(grant));
  if (!isSubset) {
    throw new PluginGrantEscalationError(id, grants, declared);
  }

  await db
    .update(plugins)
    .set({ grantedCapabilities: grants, updatedAt: new Date() })
    .where(eq(plugins.id, id));
}

export async function removePlugin(id: string): Promise<void> {
  await db.delete(plugins).where(eq(plugins.id, id));
}
