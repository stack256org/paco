import "server-only";

import { eq } from "drizzle-orm";
import { open, seal } from "@/lib/crypto/secret-box";
import { db } from "@/lib/db/client";
import { instanceSettings } from "@/lib/db/schema";

/**
 * The instance's own configuration, as the product reads and writes it.
 *
 * One row, keyed by a constant, because there is exactly one instance. The
 * SMTP password is the only value that is not plain: it is sealed, because
 * nodemailer needs the original on every send and there is nothing to compare
 * a hash against.
 */

const SETTINGS_ROW_ID = true;

export type SmtpSettingsInput = {
  host: string | null;
  port: number | null;
  secure: boolean | null;
  user: string | null;
  /** `null` means "leave whatever is stored alone" — see `saveSmtpSettings`. */
  password: string | null;
  from: string | null;
};

export type StoredSmtpSettings = Omit<SmtpSettingsInput, "password"> & {
  password: string | null;
};

/**
 * BYO OpenFX provider config (Section 7 Task 5): a chat whose `backend` is
 * `"openfx"` runs its turns against this endpoint/binary instead of the
 * Claude Code CLI. `endpoint` has no effect on the OpenFX process itself
 * today — PROTOCOL.md §1 found no env var or flag that overrides where the
 * binary sends provider traffic, only `AI_GATEWAY_API_KEY`/
 * `VERCEL_OIDC_TOKEN` credential vars — so it is stored and shown for
 * forward-compatibility, not forwarded anywhere yet.
 */
export type OpenFxSettingsInput = {
  endpoint: string | null;
  /** `null` means "leave whatever is stored alone" — see `saveOpenFxSettings`. */
  apiKey: string | null;
  binaryPath: string | null;
};

export type StoredOpenFxSettings = Omit<OpenFxSettingsInput, "apiKey"> & {
  apiKey: string | null;
};

export type InstanceSettingsView = {
  appDomain: string | null;
  tlsEnabled: boolean;
  previewBaseDomain: string | null;
  smtp: StoredSmtpSettings;
  openfx: StoredOpenFxSettings;
  /** Null until the guided onboarding flow has been finished once. */
  onboardingCompletedAt: Date | null;
};

/**
 * Unseal a stored secret, treating an unreadable one as absent.
 *
 * `APP_SECRET` changing makes every sealed value unreadable. Throwing here
 * would take down mail delivery (or a chat's OpenFX turns) *and* the settings
 * page that is the only place to fix it, so an unreadable secret reads as
 * "not set" and the operator is asked for it again. `label` only decides the
 * wording of the warning; the mechanism is shared by every sealed field on
 * this table.
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
    smtp: {
      host: row?.smtpHost ?? null,
      port: row?.smtpPort ?? null,
      secure: row?.smtpSecure ?? null,
      user: row?.smtpUser ?? null,
      password: unsealSecret(row?.smtpPasswordSealed ?? null, "SMTP password"),
      from: row?.smtpFrom ?? null,
    },
    openfx: {
      endpoint: row?.openfxEndpoint ?? null,
      apiKey: unsealSecret(row?.openfxApiKeySealed ?? null, "OpenFX API key"),
      binaryPath: row?.openfxBinaryPath ?? null,
    },
    onboardingCompletedAt: row?.onboardingCompletedAt ?? null,
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
 * Store SMTP settings.
 *
 * A `null` password means the form was submitted without retyping it, which is
 * the normal case: the value is never sent to the browser, so an edit to the
 * host or the username would otherwise wipe the password every time.
 */
export async function saveSmtpSettings(
  input: SmtpSettingsInput,
): Promise<void> {
  const values = {
    smtpHost: input.host,
    smtpPort: input.port,
    smtpSecure: input.secure,
    smtpUser: input.user,
    smtpFrom: input.from,
    updatedAt: new Date(),
    ...(input.password === null
      ? {}
      : { smtpPasswordSealed: seal(input.password) }),
  };

  await db
    .insert(instanceSettings)
    .values({ id: SETTINGS_ROW_ID, ...values })
    .onConflictDoUpdate({ target: instanceSettings.id, set: values });
}

/**
 * Store OpenFX provider settings.
 *
 * A `null` `apiKey` means the form was submitted without retyping it — the
 * stored value is never sent to the browser (see `getInstanceSettings`), so
 * an edit to the endpoint or binary path would otherwise wipe the key every
 * time, exactly as `saveSmtpSettings` treats its password.
 */
export async function saveOpenFxSettings(
  input: OpenFxSettingsInput,
): Promise<void> {
  const values = {
    openfxEndpoint: input.endpoint,
    openfxBinaryPath: input.binaryPath,
    updatedAt: new Date(),
    ...(input.apiKey === null
      ? {}
      : { openfxApiKeySealed: seal(input.apiKey) }),
  };

  await db
    .insert(instanceSettings)
    .values({ id: SETTINGS_ROW_ID, ...values })
    .onConflictDoUpdate({ target: instanceSettings.id, set: values });
}

/**
 * Record that the guided first-run flow has been finished.
 *
 * Idempotent by design — the "Done" step calls this every time it is
 * reached, including a second time if an admin somehow gets back there, and
 * that just overwrites the timestamp rather than erroring.
 */
export async function markOnboardingComplete(): Promise<void> {
  const values = { onboardingCompletedAt: new Date(), updatedAt: new Date() };

  await db
    .insert(instanceSettings)
    .values({ id: SETTINGS_ROW_ID, ...values })
    .onConflictDoUpdate({ target: instanceSettings.id, set: values });
}
