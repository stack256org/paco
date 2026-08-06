import { redirect } from "next/navigation";
import { resolveOnboardingEntry } from "@/lib/instance-onboarding";
import { getServerSession } from "@/lib/session/get-server-session";
import { HomePage } from "./home-page";

export default async function Home() {
  const session = await getServerSession();

  // A fresh, unclaimed instance, or an admin who has not finished the
  // guided setup, goes there instead of wherever they would otherwise land —
  // an empty registration form with no follow-up is how an operator ends up
  // discovering their mail server is unconfigured from a silently-failed
  // invitation instead of from this flow.
  const entry = await resolveOnboardingEntry(session?.user?.id ?? null);
  if (entry.onOnboarding) {
    redirect("/onboarding");
  }

  if (session?.user) {
    redirect("/sessions");
  }

  return <HomePage hasSessionCookie={false} lastRepo={null} />;
}
