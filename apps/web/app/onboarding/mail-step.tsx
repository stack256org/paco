"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { SmtpSection } from "@/app/settings/admin/smtp-section";
import { getInstanceSettings } from "@/lib/admin/instance-settings-actions";

/**
 * The step that actually matters: nobody can be invited to this instance
 * until a mail server is set, because an invitation is an email.
 *
 * `SmtpSection` is reused wholesale for the form itself, the "Send a test
 * email" flow, and the never-prefilled password field — rebuilding a second
 * set of the same inputs here is exactly the kind of thing that drifts from
 * the reviewed original. What this step adds is onboarding-specific: whether
 * to call the primary action "Continue" or "Skip for now", and the
 * consequence of choosing the latter.
 *
 * `hasHost` starts `null` (still loading) rather than defaulting to
 * "unconfigured", specifically so a resumed onboarding — an admin who set
 * this up in an earlier visit and is only now getting back to click through
 * — reports its real state instead of a false warning.
 */
export function MailStep({ onContinue }: { onContinue: () => void }) {
  const [hasHost, setHasHost] = useState<boolean | null>(null);

  const loadConfigured = useCallback(async () => {
    try {
      const settings = await getInstanceSettings();
      setHasHost(settings.smtp.host !== null);
    } catch {
      setHasHost(false);
    }
  }, []);

  useEffect(() => {
    void loadConfigured();
  }, [loadConfigured]);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Mail server</h2>
        <p className="mt-1 text-sm text-base-content/60">
          This is the step that matters most. Without it, nobody else can join
          this Paco.
        </p>
      </div>

      <SmtpSection onSaved={setHasHost} />

      {hasHost === false ? (
        <div className="alert alert-warning alert-soft" role="alert">
          <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
          <span>
            Skipping this means nobody can be invited yet — the invite form will
            refuse until a mail server is set. You can always finish this later
            from Settings &rarr; Admin.
          </span>
        </div>
      ) : null}

      <div className="flex justify-end">
        {hasHost === null ? (
          <button className="btn btn-sm" disabled type="button">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          </button>
        ) : (
          <button className="btn btn-sm" onClick={onContinue} type="button">
            {hasHost ? "Continue" : "Skip for now"}
          </button>
        )}
      </div>
    </div>
  );
}
