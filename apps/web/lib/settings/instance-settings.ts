import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { instanceSettings } from "@/lib/db/schema";

/**
 * The instance's own configuration, as the product reads and writes it.
 *
 * One row, keyed by a constant, because there is exactly one instance.
 */

const SETTINGS_ROW_ID = true;

export type InstanceSettingsView = {
  appDomain: string | null;
  tlsEnabled: boolean;
  previewBaseDomain: string | null;
};

export async function readInstanceSettings(): Promise<InstanceSettingsView> {
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.id, SETTINGS_ROW_ID))
    .limit(1);

  return {
    appDomain: row?.appDomain ?? null,
    tlsEnabled: row?.tlsEnabled ?? false,
    previewBaseDomain: row?.previewBaseDomain ?? null,
  };
}

export async function saveAppDomain(input: {
  appDomain: string | null;
  tlsEnabled: boolean;
  previewBaseDomain: string | null;
}): Promise<void> {
  const values = {
    appDomain: input.appDomain,
    tlsEnabled: input.tlsEnabled,
    previewBaseDomain: input.previewBaseDomain,
    updatedAt: new Date(),
  };

  await db
    .insert(instanceSettings)
    .values({ id: SETTINGS_ROW_ID, ...values })
    .onConflictDoUpdate({ target: instanceSettings.id, set: values });
}
