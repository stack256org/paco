"use client";

import { CheckCircle2 } from "lucide-react";
import { DomainSection } from "@/app/settings/admin/domain-section";

/**
 * What the installer already set up, presented as done rather than asked
 * for again.
 *
 * The database has nothing to configure — reaching this step at all
 * required a successful session lookup and an admin check, both of which
 * round-trip through it, so by the time this renders it is proven, not
 * assumed. The domain is the one thing worth re-showing, because installers
 * guess wrong about a public hostname more often than they get connectivity
 * wrong: `DomainSection` is reused wholesale rather than rebuilt, pre-filled
 * with whatever the installer wrote, editable, and already carrying its own
 * "saved, not yet applied — restart to pick it up" notice.
 */
export function PlatformStep({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Platform</h2>
        <p className="mt-1 text-sm text-base-content/60">
          The installer already set this up. Confirm it looks right — or fix it
          now if it doesn&rsquo;t.
        </p>
      </div>

      <div className="alert alert-success alert-soft" role="status">
        <CheckCircle2 aria-hidden="true" className="size-4 shrink-0" />
        <span>Database connected.</span>
      </div>

      <DomainSection />

      <div className="flex justify-end">
        <button className="btn btn-sm" onClick={onContinue} type="button">
          Continue
        </button>
      </div>
    </div>
  );
}
