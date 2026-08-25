import "server-only";

import {
  type Capability,
  capabilitySchema,
  pluginManifestSchema,
} from "@paco/plugin-kit";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { plugins, type NewPluginRow, type PluginRow } from "@/lib/db/schema";

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

/** Unvalidated row fetch, for callers that need to run their own checks. */
async function getRawPluginRow(id: string): Promise<PluginRow | undefined> {
  const [row] = await db.select().from(plugins).where(eq(plugins.id, id));
  return row;
}

/**
 * Re-validates a stored row's jsonb columns before it reaches a caller.
 *
 * `manifest`/`grantedCapabilities` are typed at the schema level
 * (`.$type<...>()`), but that is a compile-time annotation only — nothing
 * stops a row from predating a schema/manifest-version change or being
 * written by something other than `upsertPlugin`/`setPluginGrants`. A row
 * that fails re-validation is excluded rather than passed through: a
 * corrupted plugin row must not become a fatal error, or a false grant,
 * for every caller that lists or looks up plugins.
 */
function validatePluginRow(row: PluginRow): PluginRow | undefined {
  const manifestResult = pluginManifestSchema.safeParse(row.manifest);
  if (!manifestResult.success) {
    console.error("plugins: invalid manifest, excluding row", {
      id: row.id,
      error: manifestResult.error.message,
    });
    return;
  }

  const grantsResult = z
    .array(capabilitySchema)
    .safeParse(row.grantedCapabilities);
  if (!grantsResult.success) {
    console.error("plugins: invalid grantedCapabilities, excluding row", {
      id: row.id,
      error: grantsResult.error.message,
    });
    return;
  }

  return {
    ...row,
    manifest: manifestResult.data,
    grantedCapabilities: grantsResult.data,
  };
}

/** Every installed plugin, ordered by id. */
export async function listPlugins(): Promise<PluginRow[]> {
  const rows = await db.select().from(plugins).orderBy(asc(plugins.id));
  const validated: PluginRow[] = [];
  for (const row of rows) {
    const valid = validatePluginRow(row);
    if (valid) {
      validated.push(valid);
    }
  }
  return validated;
}

export async function getPlugin(id: string): Promise<PluginRow | undefined> {
  const row = await getRawPluginRow(id);
  return row ? validatePluginRow(row) : undefined;
}

/**
 * Install or update a plugin row.
 *
 * The supplied `manifest` is validated with `pluginManifestSchema` before
 * anything is written — throws if it doesn't parse. An installer must never
 * persist a manifest that fails validation, no matter what upstream
 * discovery already claimed about it.
 *
 * Persisted `grantedCapabilities` can only ever shrink relative to what the
 * plugin already held, never grow beyond it, and never exceed what the
 * (possibly new) manifest currently declares:
 *
 *   persisted = (supplied grants ∩ manifest.capabilities)
 *             ∪ (previous row's grants ∩ manifest.capabilities)
 *
 * That makes a plain re-install — bumping version/contentHash while always
 * passing `grantedCapabilities: []`, as the install flow does — a no-op for
 * a grant the new manifest still declares, while a manifest that drops a
 * capability silently trims any grant that depended on it. Nothing an
 * upsert does can escalate a grant beyond either what was asked for in this
 * call or what the plugin already legitimately held (spec Section 2
 * no-self-escalation invariant) — only `setPluginGrants` grants something
 * new, and only up to the manifest's declared capabilities.
 *
 * `enabled` defaults to `false` at the schema level: installing a plugin
 * only ever registers it, never runs it (consent invariant) —
 * `setPluginEnabled` is the deliberate second step.
 */
export async function upsertPlugin(row: NewPluginRow): Promise<void> {
  const parsedManifest = pluginManifestSchema.safeParse(row.manifest);
  if (!parsedManifest.success) {
    throw new Error(
      `Cannot install plugin "${row.id}": manifest is invalid: ${parsedManifest.error.message}`,
    );
  }
  const declared = parsedManifest.data.capabilities;

  const existing = await getRawPluginRow(row.id);
  const previousGrants = existing
    ? (z.array(capabilitySchema).safeParse(existing.grantedCapabilities).data ??
      [])
    : [];

  const grantedCapabilities = Array.from(
    new Set([
      ...row.grantedCapabilities.filter((grant) => declared.includes(grant)),
      ...previousGrants.filter((grant) => declared.includes(grant)),
    ]),
  );

  const updatedAt = new Date();
  if (existing) {
    await db
      .update(plugins)
      .set({ ...row, grantedCapabilities, updatedAt })
      .where(eq(plugins.id, row.id));
  } else {
    await db.insert(plugins).values({ ...row, grantedCapabilities, updatedAt });
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
 * A plugin cannot grant itself more than it asked for at install time —
 * that is the whole point of a manifest declaring capabilities up front.
 * When the stored manifest fails to parse, there is no way to verify the
 * request against anything, so every call throws — including a request for
 * zero grants — rather than treating an unverifiable manifest as declaring
 * nothing and letting an empty request through by vacuous truth.
 */
export async function setPluginGrants(
  id: string,
  grants: Capability[],
): Promise<void> {
  const row = await getRawPluginRow(id);
  if (!row) {
    throw new Error(`No plugin installed with id "${id}"`);
  }

  const parsedManifest = pluginManifestSchema.safeParse(row.manifest);
  if (!parsedManifest.success) {
    console.error(
      "plugins: cannot verify grants against an unparseable manifest, denying",
      { id, error: parsedManifest.error.message },
    );
    throw new PluginGrantEscalationError(id, grants, []);
  }

  const declared = parsedManifest.data.capabilities;
  const escalated = grants.filter((grant) => !declared.includes(grant));
  if (escalated.length > 0) {
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
