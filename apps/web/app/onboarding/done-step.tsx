"use client";

import { PartyPopper } from "lucide-react";
import { useState } from "react";
import { completeOnboarding } from "@/lib/admin/instance-settings-actions";

/**
 * The last screen of the guided flow, and the only thing that marks it
 * finished.
 *
 * `completeOnboarding` is best-effort: whether it succeeds or not, the click
 * always lands the operator in the app — there is nothing actionable for
 * them to do about a failed write here, and the flow is re-entrant by
 * design (see `lib/instance-onboarding.ts`), so a failure just means
 * `/onboarding` offers itself again next time instead of silently losing the
 * "done" state forever.
 */
export function DoneStep() {
  const [finishing, setFinishing] = useState(false);

  async function handleFinish() {
    setFinishing(true);
    try {
      await completeOnboarding();
    } catch {
      // Nothing actionable to show — see the module doc above.
    } finally {
      window.location.assign("/sessions");
    }
  }

  return (
    <div className="flex flex-col items-center gap-4 py-6 text-center">
      <PartyPopper
        aria-hidden="true"
        className="size-10 text-base-content/70"
      />
      <div>
        <h2 className="text-lg font-semibold">You&rsquo;re set up</h2>
        <p className="mt-1 max-w-sm text-sm text-base-content/60">
          This Paco is claimed, its platform settings are confirmed, and
          you&rsquo;re ready to go. You can revisit any of this later from
          Settings &rarr; Admin.
        </p>
      </div>
      <button
        className="btn"
        disabled={finishing}
        onClick={() => void handleFinish()}
        type="button"
      >
        Go to Paco
      </button>
    </div>
  );
}
