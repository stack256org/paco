import "server-only";

import { eq } from "drizzle-orm";
import { open, seal } from "@/lib/crypto/secret-box";
import { db } from "@/lib/db/client";
import { instanceSettings } from "@/lib/db/schema";

/**
 * The instance's own configuration, as the product reads and writes it.
 *
 * One row, keyed by a constant, because there is exactly one instance. The
 * Poolside API key is the only value that is not plain: it is sealed,
 * because `pool` needs the original on every call and there is nothing to
 * compare a hash against.
 */

const SETTINGS_ROW_ID = true;

/**
 * BYO Poolside provider config: a chat whose `backend` is `"poolside"` runs
 * its turns through the `pool` CLI configured here instead of the Claude
 * Code CLI.
 *
 * Every field is load-bearing — each one is handed to the spawned process,
 * so nothing here is stored-but-inert. `pool` reads
 * `POOLSIDE_STANDALONE_BASE_URL` and `POOLSIDE_API_KEY` from its
 * environment, and `binaryPath` is the executable spawned. `baseUrl` is
 * named for what it is: the base URL of the Poolside deployment to talk to.
 */
export type PoolsideSettingsInput = {
  /** `null` means Poolside's own default service; set it for a standalone deployment. */
  baseUrl: string | null;
  /** `null` means "leave whatever is stored alone" — see `savePoolsideSettings`. */
  apiKey: string | null;
  /** `null` means "find `pool` on `PATH`". */
  binaryPath: string | null;
};

export type StoredPoolsideSettings = Omit<PoolsideSettingsInput, "apiKey"> & {
  apiKey: string | null;
};

export type InstanceSettingsView = {
  appDomain: string | null;
  tlsEnabled: boolean;
  previewBaseDomain: string | null;
  poolside: StoredPoolsideSettings;
};

/**
 * Unseal a stored secret, treating an unreadable one as absent.
 *
 * `APP_SECRET` changing makes every sealed value unreadable. Throwing here
 * would take down a chat's Poolside turns *and* the settings page that is
 * the only place to fix it, so an unreadable secret reads as "not set" and
 * the operator is asked for it again. `label` only decides the wording of
 * the warning; the mechanism is shared by every sealed field on this table.
 */
function unsealSecret(sealed: string | null, label: string): string | null {
  if (!sealed) {
    return null;
  }

  try {
    return open(sealed);
  } catch {
    console.warn(
      `[settings] The stored ${label} could not be read. APP_SECRET has most likely changed; re-enter it in Settings.`,
    );
    return null;
  }
}

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
    poolside: {
      baseUrl: row?.poolsideBaseUrl ?? null,
      apiKey: unsealSecret(
        row?.poolsideApiKeySealed ?? null,
        "Poolside API key",
      ),
      binaryPath: row?.poolsideBinaryPath ?? null,
    },
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
 * Store Poolside provider settings.
 *
 * A `null` `apiKey` means the form was submitted without retyping it — the
 * stored value is never sent to the browser (see `getInstanceSettings`), so
 * an edit to the base URL or binary path would otherwise wipe the key every
 * time.
 */
export async function savePoolsideSettings(
  input: PoolsideSettingsInput,
): Promise<void> {
  const values = {
    poolsideBaseUrl: input.baseUrl,
    poolsideBinaryPath: input.binaryPath,
    updatedAt: new Date(),
    ...(input.apiKey === null
      ? {}
      : { poolsideApiKeySealed: seal(input.apiKey) }),
  };

  await db
    .insert(instanceSettings)
    .values({ id: SETTINGS_ROW_ID, ...values })
    .onConflictDoUpdate({ target: instanceSettings.id, set: values });
}
