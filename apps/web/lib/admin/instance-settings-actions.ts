"use server";

import type { z } from "zod";
import { sendEmail } from "@/lib/email/mailer";
import { resolveSmtpConfig } from "@/lib/email/smtp-config";
import {
  markOnboardingComplete,
  readInstanceSettings,
  saveAppDomain,
  saveSmtpSettings,
} from "@/lib/settings/instance-settings";
import {
  domainSchema,
  emailAddressSchema,
  smtpSchema,
} from "./instance-settings-schemas";
import { requireAdmin } from "./require-admin";

/**
 * The settings an administrator can change about this installation.
 *
 * The SMTP password travels one way only. `getInstanceSettings` reports
 * whether one is stored, never what it is — a settings page is exactly the
 * screen an over-broad response would leak a credential from.
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
