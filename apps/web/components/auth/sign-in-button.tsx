"use client";

import { Check, Loader2, Mail } from "lucide-react";
import { type ComponentProps, useEffect, useState } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth/client";
import { SIGN_IN_ERROR_CALLBACK_PATH } from "@/lib/auth/sign-in-failure-copy";

function resolveRedirectPath(value: string): string {
  if (value.startsWith("/") && !value.startsWith("//")) {
    return value;
  }

  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.origin === window.location.origin) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    return window.location.pathname + window.location.search;
  }

  return window.location.pathname + window.location.search;
}

type SignInButtonProps = {
  callbackUrl?: string;
  /**
   * The address an `?invitation=` link resolved to, if any.
   *
   * Prefills the email field and expands the form immediately, so someone
   * who followed the link doesn't have to click "Sign in with email" and
   * retype an address they were just sent. Purely a convenience: nothing
   * here enforces that the account created matches this address — that's
   * still `assertSignUpAllowed`'s job — so ignoring the prefill and typing a
   * different one keeps working exactly as it always has.
   */
  invitedEmail?: string | null;
} & Omit<ComponentProps<typeof Button>, "onClick">;

/**
 * Magic-link sign-in.
 *
 * Collapsed to a single button until clicked so it drops into the existing
 * layouts unchanged, then expands into an email field.
 */
export function SignInButton({
  callbackUrl,
  disabled,
  className,
  invitedEmail,
  ...props
}: SignInButtonProps) {
  const [isExpanded, setIsExpanded] = useState(Boolean(invitedEmail));
  const [email, setEmail] = useState(invitedEmail ?? "");
  const [isSending, setIsSending] = useState(false);
  const [isSent, setIsSent] = useState(false);

  // The invitation lookup resolves after this component's first render (it's
  // an async fetch), so the state initializers above only cover the case
  // where a caller somehow already had the address synchronously. This
  // effect covers the real case: the address arrives a moment later, once
  // `useInvitationEmail`'s request completes.
  useEffect(() => {
    if (invitedEmail) {
      setEmail(invitedEmail);
      setIsExpanded(true);
    }
  }, [invitedEmail]);
  /**
   * `null` until the instance has been asked whether it can send mail at all.
   *
   * Undecided is treated as "can send", so a failed probe never invents a
   * scary message on an instance whose email works perfectly.
   */
  const [deliversEmail, setDeliversEmail] = useState<boolean | null>(null);

  async function handleSend() {
    const trimmed = email.trim();
    if (!trimmed || isSending) {
      return;
    }

    setIsSending(true);
    const fallback = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const redirectPath = resolveRedirectPath(callbackUrl ?? fallback);

    const { error } = await authClient.signIn.magicLink({
      email: trimmed,
      callbackURL: redirectPath,
      // Where a *failed* verification lands. Without it better-auth falls back
      // to `callbackURL`, and `/sessions` bounces a signed-out visitor to `/`
      // and drops the query string — so an expired link explained itself to
      // nobody. See lib/auth/sign-in-failure-copy.
      errorCallbackURL: SIGN_IN_ERROR_CALLBACK_PATH,
    });

    setIsSending(false);

    if (error) {
      toast.error(error.message ?? "Could not send the sign-in link");
      return;
    }

    // Ask only now, so a visitor who never tries to sign in causes no request.
    let canDeliver = true;
    try {
      const response = await fetch("/api/auth/email-delivery");
      if (response.ok) {
        const body = (await response.json()) as { deliversEmail?: boolean };
        canDeliver = body.deliversEmail !== false;
      }
    } catch {
      // Assume it works; the honest-but-wrong direction is the safer one.
    }

    setDeliversEmail(canDeliver);
    setIsSent(true);

    if (canDeliver) {
      toast.success("Check your email for a sign-in link");
    }
  }

  function handleStartOver() {
    setIsSent(false);
    setDeliversEmail(null);
    setIsExpanded(true);
  }

  if (isSent) {
    return (
      <div className="flex w-full max-w-sm flex-col gap-2">
        {deliversEmail === false ? (
          <div className="alert alert-warning alert-soft alert-vertical text-left">
            <div>
              <h3 className="font-bold text-sm">
                This Paco can&rsquo;t send email yet
              </h3>
              <p className="text-xs">
                Nothing was sent to {email.trim()}. Your sign-in link was
                written to the server&rsquo;s log instead — open it there to
                sign in. To get links by email, set the SMTP settings and
                restart Paco.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm">
            <Check aria-hidden="true" className="size-4 shrink-0" />
            <span>Link sent to {email.trim()}</span>
          </div>
        )}
        <p className="text-left text-base-content/60 text-xs">
          {deliversEmail === false
            ? "Wrong address?"
            : "It can take a minute, and it may land in your spam folder."}{" "}
          <button
            className="link link-hover"
            onClick={handleStartOver}
            type="button"
          >
            Use a different address
          </button>
        </p>
      </div>
    );
  }

  if (!isExpanded) {
    return (
      <Button
        {...props}
        className={className}
        disabled={disabled}
        onClick={() => setIsExpanded(true)}
      >
        <Mail />
        Sign in with email
      </Button>
    );
  }

  return (
    <div className="flex w-full max-w-sm flex-col gap-2">
      {invitedEmail ? (
        <div className="alert alert-info alert-soft" role="status">
          <span>
            You&rsquo;ve been invited as <strong>{invitedEmail}</strong>.
          </span>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <Input
          aria-label="Email address"
          autoComplete="email"
          autoFocus
          disabled={isSending}
          onChange={(event) => setEmail(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              void handleSend();
            }
          }}
          placeholder="you@example.com"
          type="email"
          value={email}
        />
        <Button
          {...props}
          aria-busy={isSending}
          className={className}
          disabled={isSending || email.trim().length === 0}
          onClick={handleSend}
        >
          {isSending ? <Loader2 className="animate-spin" /> : <Mail />}
          {isSending ? "Sending..." : "Send link"}
        </Button>
      </div>
    </div>
  );
}
