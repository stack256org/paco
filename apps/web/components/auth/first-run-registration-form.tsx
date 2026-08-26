"use client";

import { Loader2 } from "lucide-react";
import { type FormEvent, useState } from "react";

type FirstRunResponse = { success?: boolean; error?: string };

function isFirstRunResponse(value: unknown): value is FirstRunResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.success === undefined || typeof record.success === "boolean") &&
    (record.error === undefined || typeof record.error === "string")
  );
}

/**
 * Claims a fresh Paco install.
 *
 * The account this creates becomes the instance's owner (see
 * `POST /api/auth/first-run` for the hooks that make that happen), and it
 * signs the browser straight into a session on success — no email round
 * trip, because SMTP is not configured yet on a fresh install and pointing
 * the very first person at a server log to reach their own instance is not
 * an acceptable first impression.
 *
 * `onClaimed`, when given, is called instead of navigating to `/sessions` —
 * the guided onboarding flow (`app/onboarding`) renders this as its first
 * step and wants to move to the next one in place, not leave the flow. The
 * session cookie the response just set is already in the browser by then,
 * so the next step's own requests (server actions, etc.) carry it with no
 * navigation required to pick it up.
 */
export function FirstRunRegistrationForm({
  onClaimed,
}: {
  onClaimed?: () => void;
} = {}) {
  const [email, setEmail] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail || submitting) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/first-run", {
        body: JSON.stringify({
          email: trimmedEmail,
          organizationName: organizationName.trim() || undefined,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      const body: unknown = await response.json().catch(() => null);
      const parsed = isFirstRunResponse(body) ? body : null;

      if (!(response.ok && parsed?.success)) {
        setError(parsed?.error ?? "Could not create the account. Try again.");
        setSubmitting(false);
        return;
      }

      if (onClaimed) {
        onClaimed();
        return;
      }

      // A full navigation, not the client router: the session cookie the
      // response just set has to be picked up by every server component on
      // the next page, not merely the client-side router cache.
      window.location.assign("/sessions");
    } catch {
      setError("Could not create the account. Try again.");
      setSubmitting(false);
    }
  }

  return (
    <form className="fieldset" onSubmit={(event) => void handleSubmit(event)}>
      <legend className="fieldset-legend">Claim this instance</legend>
      <p className="text-base-content/70 text-sm">
        Nobody has signed in yet. Creating an account here makes it this
        instance&rsquo;s owner — from then on, everyone else joins by invitation
        only.
      </p>

      {/*
        Said plainly rather than left implicit. Until an owner exists, this form
        accepts whatever address reached it — which is what makes a fresh
        install claimable at all, and is also worth knowing: anyone who can
        reach this page right now can take the instance. The honest advice is
        to do it now, and the domain gets pinned in the next step.
      */}
      <p className="text-base-content/50 text-xs">
        No domain is set yet, so this page answers on any address that reaches
        this server. Claim it now — you&rsquo;ll set the domain in the next
        step, and after that only that address is accepted.
      </p>

      {error ? (
        <div className="alert alert-error alert-soft" role="alert">
          <span>{error}</span>
        </div>
      ) : null}

      <label className="label" htmlFor="first-run-email">
        Email
      </label>
      <input
        autoComplete="email"
        className="input w-full"
        disabled={submitting}
        id="first-run-email"
        onChange={(event) => setEmail(event.target.value)}
        placeholder="you@example.com"
        required
        type="email"
        value={email}
      />

      <label className="label" htmlFor="first-run-org">
        Organisation name
      </label>
      <input
        className="input w-full"
        disabled={submitting}
        id="first-run-org"
        onChange={(event) => setOrganizationName(event.target.value)}
        placeholder="Your team's name"
        type="text"
        value={organizationName}
      />
      <p className="text-base-content/60 text-xs">
        Optional — defaults to &ldquo;Paco&rdquo;.
      </p>

      <button
        className="btn mt-4 w-full"
        disabled={submitting || email.trim() === ""}
        type="submit"
      >
        {submitting ? (
          <Loader2 aria-hidden="true" className="size-4 animate-spin" />
        ) : null}
        {submitting ? "Creating…" : "Create account"}
      </button>
    </form>
  );
}
