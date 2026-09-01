import "server-only";

import { eq } from "drizzle-orm";
import { open, seal } from "@/lib/crypto/secret-box";
import { db } from "@/lib/db/client";
import { instanceSettings } from "@/lib/db/schema";

/**
 * The instance's own configuration, as the product reads and writes it.
 *
 * One row, keyed by a constant, because there is exactly one instance.
 */

const SETTINGS_ROW_ID = true;

/** Which kind of Claude credential this instance is configured with. See `schema.ts`. */
export type ClaudeCredentialKind = "api_key" | "setup_token";

/**
 * The instance's Claude credential, decrypted.
 *
 * Never put this shape on `InstanceSettingsView` — that view crosses to the
 * client, and this one carries the secret in the clear.
 */
export type ClaudeCredential = {
  kind: ClaudeCredentialKind;
  value: string;
  setAt: Date;
};

export type InstanceSettingsView = {
  appDomain: string | null;
  tlsEnabled: boolean;
  previewBaseDomain: string | null;
  /** Which kind of credential is configured, never the value itself. */
  claudeCredentialKind: ClaudeCredentialKind | null;
  claudeCredentialSetAt: Date | null;
  claudeBaseUrl: string | null;
  claudeModelDiscovery: boolean;
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
    claudeCredentialKind: row?.claudeCredentialKind ?? null,
    claudeCredentialSetAt: row?.claudeCredentialSetAt ?? null,
    claudeBaseUrl: row?.claudeBaseUrl ?? null,
    claudeModelDiscovery: row?.claudeModelDiscovery ?? false,
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

/**
 * The instance's Claude credential, ready to hand to the CLI.
 *
 * Returns `null` when nothing is configured, and also when only half of the
 * pair (kind, sealed value) is present — which should not happen through
 * `saveClaudeCredential`, but a half-populated row is not a credential
 * either way, so it is treated the same as "unconfigured" rather than
 * thrown as an error.
 */
export async function readClaudeCredential(): Promise<ClaudeCredential | null> {
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.id, SETTINGS_ROW_ID))
    .limit(1);

  if (
    !row?.claudeCredentialKind ||
    !row.claudeCredentialSealed ||
    !row.claudeCredentialSetAt
  ) {
    return null;
  }

  return {
    kind: row.claudeCredentialKind,
    value: open(row.claudeCredentialSealed),
    setAt: row.claudeCredentialSetAt,
  };
}

/**
 * Store (or replace) this instance's Claude credential.
 *
 * Writes kind, sealed value and timestamp together in one update, so the two
 * kinds can never both be present at once — see the schema comment on
 * `claudeCredentialKind` for why that matters.
 */
export async function saveClaudeCredential(input: {
  kind: ClaudeCredentialKind;
  value: string;
}): Promise<void> {
  const values = {
    claudeCredentialKind: input.kind,
    claudeCredentialSealed: seal(input.value),
    claudeCredentialSetAt: new Date(),
    updatedAt: new Date(),
  };

  await db
    .insert(instanceSettings)
    .values({ id: SETTINGS_ROW_ID, ...values })
    .onConflictDoUpdate({ target: instanceSettings.id, set: values });
}

/** Save the gateway this instance points the Claude CLI at. Null `baseUrl` means Anthropic. */
export async function saveClaudeGateway(input: {
  baseUrl: string | null;
  modelDiscovery: boolean;
}): Promise<void> {
  const values = {
    claudeBaseUrl: input.baseUrl,
    claudeModelDiscovery: input.modelDiscovery,
    updatedAt: new Date(),
  };

  await db
    .insert(instanceSettings)
    .values({ id: SETTINGS_ROW_ID, ...values })
    .onConflictDoUpdate({ target: instanceSettings.id, set: values });
}
