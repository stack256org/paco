"use client";

import { useState } from "react";
import { FirstRunRegistrationForm } from "@/components/auth/first-run-registration-form";
import type { OnboardingStep } from "@/lib/instance-onboarding";
import { DoneStep } from "./done-step";
import { PlatformStep } from "./platform-step";

type FlowStep = OnboardingStep | "done";

const STEP_LABELS: Record<FlowStep, string> = {
  account: "Account",
  platform: "Platform",
  done: "Done",
};

const STEP_ORDER: FlowStep[] = ["account", "platform", "done"];

/**
 * The guided first-run flow, run once on a fresh instance.
 *
 * `initialStep` comes from the server (`resolveOnboardingEntry`) and is
 * exactly one of two values: `"account"` for an unclaimed instance, or
 * `"platform"` for a signed-in admin resuming after account creation —
 * repeating `POST /api/auth/first-run` for someone already signed in would
 * just 409. Every later transition is local state, not a navigation: the
 * session cookie `FirstRunRegistrationForm` obtains is already in the
 * browser once it calls back, so the next step's server actions pick it up
 * with no reload needed.
 */
export function OnboardingFlow({
  initialStep,
}: {
  initialStep: OnboardingStep;
}) {
  const [step, setStep] = useState<FlowStep>(initialStep);
  const currentIndex = STEP_ORDER.indexOf(step);

  return (
    <div className="flex min-h-screen items-center justify-center bg-base-200 px-4 py-10">
      <div className="card w-full max-w-2xl bg-base-100 shadow-sm">
        <div className="card-body gap-6">
          <div>
            <h1 className="card-title text-2xl">Set up Paco</h1>
            <p className="mt-1 text-sm text-base-content/60">
              A few steps, once, before this instance is ready to use.
            </p>
          </div>

          <ul className="steps steps-vertical sm:steps-horizontal">
            {STEP_ORDER.map((s, index) => (
              <li
                className={index <= currentIndex ? "step step-primary" : "step"}
                key={s}
              >
                {STEP_LABELS[s]}
              </li>
            ))}
          </ul>

          {step === "account" ? (
            <FirstRunRegistrationForm onClaimed={() => setStep("platform")} />
          ) : null}

          {step === "platform" ? (
            <PlatformStep onContinue={() => setStep("done")} />
          ) : null}

          {step === "done" ? <DoneStep /> : null}
        </div>
      </div>
    </div>
  );
}
