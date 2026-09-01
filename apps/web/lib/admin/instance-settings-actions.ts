"use server";

import type { z } from "zod";
import {
  readInstanceSettings,
  saveAppDomain,
} from "@/lib/settings/instance-settings";
import { domainSchema } from "./instance-settings-schemas";

/**
 * The settings an administrator can change about this installation.
 */
export async function getInstanceSettings() {
  const settings = await readInstanceSettings();

  return {
    appDomain: settings.appDomain,
    tlsEnabled: settings.tlsEnabled,
    previewBaseDomain: settings.previewBaseDomain,
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
