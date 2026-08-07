"use client";

import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { DomainSection } from "@/app/settings/admin/domain-section";
import { getInstanceSettings } from "@/lib/admin/instance-settings-actions";

/**
 * Confirm how this instance is reached, and require a domain before moving on.
 *
 * Reaching Paco never needs one — it answers on whatever address the request
 * arrived at, which is why the installer prints an IP and that IP just works.
 * What a domain decides is the addresses Paco *sends*: invitations and sign-in
 * links are built from it. Left blank, those are built from `APP_URL`, which on
 * a default install is the `http://localhost:3000` fallback — a link nobody but
 * the operator's own shell can open, mailed to somebody else. That failure
 * appears days later, in someone else's inbox, and reads as "the invite is
 * broken" rather than as a setting nobody filled in.
 *
 * So this step blocks. Every other step here is skippable or already done; this
 * is the one where deferring the decision costs more than making it.
 *
 * The database has nothing to confirm — reaching this step required a session
 * lookup and an admin check, both of which round-trip through it, so by the
 * time this renders it is proven rather than assumed.
 *
 * `hasDomain` starts `null` (still loading) rather than `false`, so a resumed
 * onboarding — an admin who set this up earlier and is only now clicking
 * through — is not told off for something they already did.
 */
export function PlatformStep({ onContinue }: { onContinue: () => void }) {
  const [hasDomain, setHasDomain] = useState<boolean | null>(null);

  const loadConfigured = useCallback(async () => {
    try {
      const settings = await getInstanceSettings();
      setHasDomain(settings.appDomain !== null);
    } catch {
      setHasDomain(false);
    }
  }, []);

  useEffect(() => {
    void loadConfigured();
  }, [loadConfigured]);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Platform</h2>
        <p className="mt-1 text-sm text-base-content/60">
          Set the address people will use to reach this Paco. Point a DNS record
          at this host first, then enter it here.
        </p>
      </div>

      <div className="alert alert-success alert-soft" role="status">
        <CheckCircle2 aria-hidden="true" className="size-4 shrink-0" />
        <span>Database connected.</span>
      </div>

      <DomainSection onSaved={setHasDomain} />

      {hasDomain === false ? (
        <div className="alert alert-warning alert-soft" role="alert">
          <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
          <span>
            A domain is required to continue. You can keep using Paco at this
            host&rsquo;s address either way — this is what invitation and
            sign-in links get built from, and without it they point somewhere
            only this server can open.
          </span>
        </div>
      ) : null}

      <div className="flex justify-end">
        {hasDomain === null ? (
          <button className="btn btn-sm" disabled type="button">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          </button>
        ) : (
          <button
            className="btn btn-sm"
            disabled={!hasDomain}
            onClick={onContinue}
            type="button"
          >
            Continue
          </button>
        )}
      </div>
    </div>
  );
}
