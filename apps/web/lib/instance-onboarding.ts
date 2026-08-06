import "server-only";

import { isAdmin } from "@/lib/admin/require-admin";
import { isFirstRun } from "@/lib/auth/first-run";
import { readInstanceSettings } from "@/lib/settings/instance-settings";

export type OnboardingStep = "account" | "platform";

/**
 * Where a request should land, with respect to the guided onboarding flow.
 *
 * One rule, evaluated fresh on every request rather than cached in a cookie
 * or client-side flag: onboarding is reachable only while the instance is
 * unclaimed, or by an admin who has not finished it yet.
 *
 * - Signed out, unclaimed instance: the flow starts at account creation.
 * - Signed out, claimed instance: ordinary sign-in — never onboarding.
 * - Signed in, onboarding already finished, or not an admin: never
 *   onboarding, regardless of how they got here.
 * - Signed in, admin, onboarding unfinished: resume at the platform step —
 *   the account step is already done and `POST /api/auth/first-run` would
 *   409 on it anyway.
 *
 * Shared between `/` (which redirects a still-onboarding admin here instead
 * of to `/sessions`) and `/onboarding` itself (which redirects everyone
 * else away), so the rule cannot drift between the two call sites.
 */
export async function resolveOnboardingEntry(
  userId: string | null,
): Promise<
  | { onOnboarding: true; initialStep: OnboardingStep }
  | { onOnboarding: false; landingPath: string }
> {
  if (userId === null) {
    if (await isFirstRun()) {
      return { onOnboarding: true, initialStep: "account" };
    }
    return { onOnboarding: false, landingPath: "/" };
  }

  const settings = await readInstanceSettings();
  if (settings.onboardingCompletedAt !== null) {
    return { onOnboarding: false, landingPath: "/sessions" };
  }
  if (!(await isAdmin(userId))) {
    return { onOnboarding: false, landingPath: "/sessions" };
  }
  return { onOnboarding: true, initialStep: "platform" };
}
