import "server-only";

import { getGithubConnection } from "@/lib/db/github-tokens";

/**
 * Whether a user still needs to go through onboarding.
 *
 * One question now: is a GitHub credential stored. The App version asked two —
 * is an account linked, and is the app installed somewhere — because it was
 * possible to have done one and not the other, and neither alone was enough to
 * do anything with.
 */
export async function needsOnboarding(userId: string): Promise<boolean> {
  return (await getGithubConnection(userId)) === null;
}
