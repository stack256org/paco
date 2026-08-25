"use server";

import { tmpdir } from "node:os";
import type { z } from "zod";
import { sendEmail } from "@/lib/email/mailer";
import { resolveSmtpConfig } from "@/lib/email/smtp-config";
import {
  markOnboardingComplete,
  readInstanceSettings,
  saveAppDomain,
  saveOpenFxSettings,
  saveSmtpSettings,
} from "@/lib/settings/instance-settings";
import {
  domainSchema,
  emailAddressSchema,
  openFxSchema,
  smtpSchema,
} from "./instance-settings-schemas";
import { requireAdmin } from "./require-admin";

/**
 * The settings an administrator can change about this installation.
 *
 * The SMTP password (and the OpenFX API key) travel one way only.
 * `getInstanceSettings` reports whether one is stored, never what it is — a
 * settings page is exactly the screen an over-broad response would leak a
 * credential from.
 */
export async function getInstanceSettings() {
  await requireAdmin();
  const settings = await readInstanceSettings();

  return {
    appDomain: settings.appDomain,
    tlsEnabled: settings.tlsEnabled,
    previewBaseDomain: settings.previewBaseDomain,
    smtp: {
      host: settings.smtp.host,
      port: settings.smtp.port,
      secure: settings.smtp.secure,
      user: settings.smtp.user,
      from: settings.smtp.from,
      hasPassword: settings.smtp.password !== null,
    },
    openfx: {
      endpoint: settings.openfx.endpoint,
      binaryPath: settings.openfx.binaryPath,
      hasApiKey: settings.openfx.apiKey !== null,
    },
  };
}

export async function updateAppDomain(
  input: z.infer<typeof domainSchema>,
): Promise<{ success: boolean; error?: string }> {
  await requireAdmin();

  const parsed = domainSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Those settings are not valid.",
    };
  }

  await saveAppDomain(parsed.data);
  return { success: true };
}

export async function updateSmtpSettings(
  input: z.infer<typeof smtpSchema>,
): Promise<{ success: boolean; error?: string }> {
  await requireAdmin();

  const parsed = smtpSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Those settings are not valid.",
    };
  }

  await saveSmtpSettings(parsed.data);
  return { success: true };
}

export async function updateOpenFxSettings(
  input: z.infer<typeof openFxSchema>,
): Promise<{ success: boolean; error?: string }> {
  await requireAdmin();

  const parsed = openFxSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Those settings are not valid.",
    };
  }

  await saveOpenFxSettings(parsed.data);
  return { success: true };
}

/** How long `testOpenFxConnection` waits before giving up on a hung process. */
const OPENFX_HANDSHAKE_TIMEOUT_MS = 15_000;

/**
 * Prove the stored OpenFX settings actually reach a running `openfx acp`
 * process, before a chat depends on them.
 *
 * A cheap handshake: spawn the binary, send `initialize`, and tear the
 * process down the moment it answers — the same first two frames
 * `OpenFxBackend.startTurn` exchanges on every real turn (PROTOCOL.md §4),
 * without creating a session or running a prompt. `cwd` is `tmpdir()` rather
 * than a chat's worktree: PROTOCOL.md §1 notes the workspace root only
 * matters once a session exists, and this test never creates one.
 */
export async function testOpenFxConnection(): Promise<{
  success: boolean;
  error?: string;
}> {
  await requireAdmin();

  const settings = await readInstanceSettings();
  if (!(settings.openfx.binaryPath || settings.openfx.apiKey)) {
    return {
      success: false,
      error:
        "Set a binary path or API key first — there is nothing to test yet.",
    };
  }

  const { AcpClient } = await import("@paco/openfx-backend");
  const client = new AcpClient({
    cwd: tmpdir(),
    ...(settings.openfx.binaryPath
      ? { executable: settings.openfx.binaryPath }
      : {}),
    ...(settings.openfx.apiKey
      ? { env: { AI_GATEWAY_API_KEY: settings.openfx.apiKey } }
      : {}),
  });

  try {
    await Promise.race([
      client.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("The OpenFX binary did not respond in time.")),
          OPENFX_HANDSHAKE_TIMEOUT_MS,
        );
      }),
    ]);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "The OpenFX binary did not respond.",
    };
  } finally {
    await client.close();
  }
}

/**
 * Prove the SMTP settings work, before an invitation depends on them.
 *
 * Sent inline rather than queued: the point is to report the failure to the
 * person who just typed the settings in, and a queued job would swallow it
 * into a worker log.
 */
export async function sendTestEmail(
  to: string,
): Promise<{ success: boolean; error?: string }> {
  await requireAdmin();

  const address = emailAddressSchema.safeParse(to);
  if (!address.success) {
    return {
      success: false,
      error: "That does not look like an email address.",
    };
  }

  if (!(await resolveSmtpConfig())) {
    return {
      success: false,
      error: "Set a mail server first — there is nothing to send with yet.",
    };
  }

  try {
    await sendEmail({
      to: address.data,
      subject: "Paco test email",
      text: "This is a test message from Paco. Your mail settings work.",
    });
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "The mail server refused the message.",
    };
  }
}

/**
 * Mark the guided first-run flow finished, so `/onboarding` stops offering
 * itself to this admin.
 *
 * Called once, from the "Done" step — but idempotent, since nothing stops an
 * admin from getting back there (a bookmark, a back button) after they
 * already have.
 */
export async function completeOnboarding(): Promise<{ success: boolean }> {
  await requireAdmin();
  await markOnboardingComplete();
  return { success: true };
}
