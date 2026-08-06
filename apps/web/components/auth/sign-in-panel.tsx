"use client";

import { Suspense } from "react";
import { InvitedSignInButton } from "@/components/auth/invited-sign-in-button";
import { SignInButton } from "@/components/auth/sign-in-button";
import { SignInErrorNotice } from "@/components/auth/sign-in-error-notice";

/**
 * Everything a signed-out visitor sees.
 *
 * Paco is self-hosted and invitation-only, so there is no marketing site to
 * browse before signing in — this is the whole page. A fresh, unclaimed
 * install never reaches this component at all: `app/page.tsx` sends it to
 * `/onboarding` instead, server-side, before anything here renders. So this
 * is unconditionally the ordinary magic-link sign-in — there is no longer a
 * first-run shape to branch on.
 */
export function SignInPanel() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-base-200 px-4">
      <div className="card w-full max-w-sm bg-base-100 shadow-sm">
        <div className="card-body">
          <h1 className="card-title text-2xl">Paco</h1>

          <div className="flex flex-col gap-4">
            {/*
              Above the sign-in control on purpose: an expired link is why
              someone is looking at this page again, and they need to read
              why before reaching for the button.
            */}
            <Suspense fallback={null}>
              <SignInErrorNotice />
            </Suspense>
            <p className="text-base-content/70 text-sm">
              This Paco is invitation-only. If you weren&rsquo;t invited,
              entering your email below won&rsquo;t get you in.
            </p>
            <Suspense
              fallback={
                <SignInButton
                  callbackUrl="/sessions"
                  className="w-full"
                  size="lg"
                />
              }
            >
              <InvitedSignInButton
                callbackUrl="/sessions"
                className="w-full"
                size="lg"
              />
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  );
}
