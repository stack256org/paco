"use client";

import { PRODUCT_TAGLINE } from "@/lib/brand";

import { GithubIcon } from "@/components/github-icon";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Check } from "lucide-react";
import { PacoLogo } from "@/components/paco-logo";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/hooks/use-session";
import { sanitizeInternalRedirect } from "@/lib/redirect-safety";

type StepId = 1 | 2;

export function GetStartedFlow() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const {
    session,
    loading: sessionLoading,
    hasGitHub,
    githubLogin,
  } = useSession();
  const isGitHubReconnect = searchParams.get("step") === "github";
  const redirectPath = sanitizeInternalRedirect(
    searchParams.get("next"),
    "/sessions",
  );
  const [activeStep, setActiveStep] = useState<StepId>(
    isGitHubReconnect ? 2 : 1,
  );
  const [completedSteps, setCompletedSteps] = useState<Set<StepId>>(
    () => new Set(isGitHubReconnect ? [1] : []),
  );

  const markComplete = useCallback((step: StepId) => {
    setCompletedSteps((prev) => new Set([...prev, step]));
    if (step < 2) {
      setActiveStep((step + 1) as StepId);
    }
  }, []);

  const canOpenStep = (step: StepId): boolean => {
    if (step === 1) return true;
    for (let i = 1; i < step; i++) {
      if (!completedSteps.has(i as StepId)) return false;
    }
    return true;
  };

  const handleStepClick = (step: StepId) => {
    if (canOpenStep(step)) {
      setActiveStep(step);
    }
  };

  const steps: { id: StepId; title: string }[] = [
    { id: 1, title: "Your account" },
    { id: 2, title: "Where your work gets saved" },
  ];

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* left panel */}
      <div className="flex shrink-0 flex-col justify-between bg-neutral px-6 py-6 md:w-1/2 md:px-12 md:py-10">
        <div className="flex items-center gap-3">
          <PacoLogo className="size-7 text-primary-content/50" />
          <span className="text-lg font-semibold tracking-tight text-primary-content/50">
            Paco
          </span>
        </div>
        <p className="hidden max-w-sm text-sm leading-relaxed text-base-content/60 md:block">
          {PRODUCT_TAGLINE}
        </p>
      </div>

      {/* right panel */}
      <div className="flex flex-1 flex-col bg-base-300 px-6 py-8 md:px-10 md:py-10">
        <div className="flex w-full flex-1 flex-col">
          <h1 className="mb-6 text-2xl font-semibold tracking-tight text-primary-content">
            Get Started
          </h1>

          <div className="flex-1">
            {steps.map((step) => {
              const isActive = activeStep === step.id;
              const isCompleted = completedSteps.has(step.id);
              const isLocked = !canOpenStep(step.id);

              return (
                <div key={step.id} className="border-b border-base-300">
                  <button
                    type="button"
                    onClick={() => handleStepClick(step.id)}
                    disabled={isLocked}
                    className={`flex w-full items-center gap-3 py-4 text-left transition-colors duration-200 disabled:cursor-not-allowed ${
                      isLocked
                        ? "text-base-content/60"
                        : isCompleted
                          ? "text-base-content/70"
                          : isActive
                            ? "text-primary-content"
                            : "text-base-content/70 hover:text-base-content"
                    }`}
                  >
                    <span
                      className={`text-sm tabular-nums ${
                        isLocked
                          ? "text-base-content"
                          : isActive
                            ? "text-primary-content"
                            : "text-base-content/60"
                      }`}
                    >
                      {step.id}.
                    </span>
                    <span
                      className={`text-sm font-medium ${isActive ? "text-primary-content" : ""}`}
                    >
                      {step.title}
                    </span>
                    {isCompleted && (
                      <Check
                        className="ml-auto size-4 text-primary-content"
                        strokeWidth={2.5}
                      />
                    )}
                  </button>

                  <div
                    className={`grid transition-all duration-300 ease-in-out ${
                      isActive
                        ? "grid-rows-[1fr] opacity-100"
                        : "grid-rows-[0fr] opacity-0"
                    }`}
                  >
                    <div className="overflow-hidden">
                      <div className="pb-5">
                        {step.id === 1 && (
                          <AccountStep
                            session={session}
                            loading={sessionLoading}
                            onComplete={() => markComplete(1)}
                          />
                        )}
                        {step.id === 2 && (
                          <GitHubConnectStep
                            githubLogin={githubLogin}
                            loading={sessionLoading}
                            hasGitHub={hasGitHub}
                            forceReconnect={isGitHubReconnect}
                            onComplete={() => {
                              markComplete(2);
                              router.push(redirectPath);
                            }}
                          />
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// step 1: signed-in account (display only)

function AccountStep({
  session,
  loading,
  onComplete,
}: {
  session: ReturnType<typeof useSession>["session"];
  loading: boolean;
  onComplete: () => void;
}) {
  if (loading) {
    return <Skeleton className="h-10 w-full rounded bg-base-content/5" />;
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-base-content/60">
        You are signed in. This is the account Paco will remember your work
        under.
      </p>
      <div className="flex items-center justify-between rounded-lg border border-base-300 px-3 py-2.5">
        <div className="flex items-center gap-3">
          <div className="size-8 rounded-full bg-base-300" />
          <div>
            <p className="text-sm font-medium text-base-content">
              {session?.user?.name ?? session?.user?.username ?? "Account"}
            </p>
            {session?.user?.email && (
              <p className="text-xs text-base-content/60">
                {session.user.email}
              </p>
            )}
          </div>
        </div>
      </div>
      <Button
        size="sm"
        onClick={onComplete}
        className="gap-2 bg-neutral-content text-neutral hover:bg-neutral-content/90"
      >
        Continue
      </Button>
    </div>
  );
}

// step 2: github connect

/*
 * There used to be a third state here: linked-but-app-not-installed, guarded by
 * `hasGitHub && !hasGitHub` — always false, so the screen behind it could never
 * appear. It was written when GitHub access came from a GitHub App and the
 * session reported two separate facts (account linked, app installed). Paco
 * dropped the App: access is now one stored token, `hasGitHub` is one boolean,
 * and `/api/github/app/install` does not exist. So the branch is deleted rather
 * than repaired — there is no second condition left for it to test.
 *
 * The connect action goes to Settings for the same reason: linking is done by
 * pasting a token, not by an OAuth round trip.
 */
function GitHubConnectStep({
  githubLogin,
  loading,
  hasGitHub,
  forceReconnect,
  onComplete,
}: {
  /**
   * The connected GitHub account, which is not the Paco account.
   *
   * This used to read `session.user.username` — a name derived from the
   * magic-link email — under a heading that says "GitHub connected". Back when
   * signing in *was* signing in with GitHub the two were the same string; now
   * they are unrelated, and the screen was confidently naming the wrong one.
   */
  githubLogin: string | null;
  loading: boolean;
  hasGitHub: boolean;
  forceReconnect: boolean;
  onComplete: () => void;
}) {
  const isConnected = !forceReconnect && hasGitHub;

  if (loading) {
    return <Skeleton className="h-10 w-full rounded bg-base-content/5" />;
  }

  if (isConnected) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between rounded-lg border border-base-300 px-3 py-2.5">
          <div className="flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-full bg-base-300">
              <GithubIcon className="size-4 text-base-content/70" />
            </div>
            <div>
              <p className="text-sm font-medium text-base-content">
                GitHub connected
              </p>
              {githubLogin && (
                <p className="text-xs text-base-content/60">@{githubLogin}</p>
              )}
            </div>
          </div>
          <Check className="size-4 text-success" strokeWidth={2.5} />
        </div>
        <Button
          size="sm"
          onClick={onComplete}
          className="gap-2 bg-neutral-content text-neutral hover:bg-neutral-content/90"
        >
          Get Started
        </Button>
      </div>
    );
  }

  // not connected
  return (
    <div className="space-y-3">
      <p className="text-xs text-base-content/60">
        {forceReconnect
          ? "Your saved GitHub connection stopped working. Connect it again so Paco can keep saving your work."
          : "Connect GitHub and Paco can save your work there for you: new repositories, backed-up changes, and pull requests when you want them."}
      </p>
      <Button
        asChild
        variant="outline"
        className="gap-2 border-base-300 bg-transparent text-base-content/70 hover:bg-base-content/5 hover:text-base-content"
      >
        <Link href="/settings/connections">
          <GithubIcon className="size-4" />
          {forceReconnect ? "Reconnect GitHub" : "Connect GitHub"}
        </Link>
      </Button>
    </div>
  );
}
