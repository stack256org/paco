"use server";

import type { z } from "zod";
import {
  readInstanceSettings,
  saveAppDomain,
  saveClaudeCredential,
  saveClaudeGateway,
} from "@/lib/settings/instance-settings";
import {
  claudeCredentialSchema,
  claudeGatewaySchema,
  domainSchema,
} from "./instance-settings-schemas";

/**
 * The settings an administrator can change about this installation.
 *
 * Never includes the Claude credential's value — only which kind is
 * configured and when it was saved. The value stays server-side.
 */
export async function getInstanceSettings() {
  const settings = await readInstanceSettings();

  return {
    appDomain: settings.appDomain,
    tlsEnabled: settings.tlsEnabled,
    previewBaseDomain: settings.previewBaseDomain,
    claudeCredentialKind: settings.claudeCredentialKind,
    claudeCredentialSetAt: settings.claudeCredentialSetAt,
    claudeBaseUrl: settings.claudeBaseUrl,
    claudeModelDiscovery: settings.claudeModelDiscovery,
  };
}

export async function updateAppDomain(
  input: z.infer<typeof domainSchema>,
): Promise<{ success: boolean; error?: string }> {
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

export async function updateClaudeCredential(
  input: z.infer<typeof claudeCredentialSchema>,
): Promise<{ success: boolean; error?: string }> {
  const parsed = claudeCredentialSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Those settings are not valid.",
    };
  }

  await saveClaudeCredential(parsed.data);
  return { success: true };
}

export async function updateClaudeGateway(
  input: z.infer<typeof claudeGatewaySchema>,
): Promise<{ success: boolean; error?: string }> {
  const parsed = claudeGatewaySchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Those settings are not valid.",
    };
  }

  await saveClaudeGateway(parsed.data);
  return { success: true };
}
