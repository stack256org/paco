import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { resolveOnboardingEntry } from "@/lib/instance-onboarding";
import { getServerSession } from "@/lib/session/get-server-session";
import { OnboardingFlow } from "./onboarding-flow";

export const metadata: Metadata = {
  title: "Set up Paco",
  description: "Claim this installation and finish the guided first-run setup.",
};

/**
 * The guided first-run flow: claim the instance, confirm the platform the
 * installer already set up, and set a mail server before anyone can be
 * invited.
 *
 * Reachable only while the rule in `resolveOnboardingEntry` says so — never
 * by an anonymous visitor once the instance is claimed, and never by anyone
 * who has already finished it. Everyone else is redirected away rather than
 * shown a locked or partial version of this page.
 */
export default async function OnboardingPage() {
  const session = await getServerSession();
  const entry = await resolveOnboardingEntry(session?.user?.id ?? null);

  if (!entry.onOnboarding) {
    redirect(entry.landingPath);
  }

  return <OnboardingFlow initialStep={entry.initialStep} />;
}
