"use client";

import { ShieldAlert } from "lucide-react";
import { useState } from "react";
import type { ApprovalRequest } from "@/lib/agent/approvals/store";
import { Button } from "@/components/ui/button";

/**
 * A tool call the agent is stopped on, waiting for a decision.
 *
 * Deliberately plain and slightly loud. The whole value of this prompt is that
 * the user reads the command before allowing it — a card that blends into the
 * transcript would be clicked through, which is the failure mode of every
 * permission dialog.
 *
 * Deny is the wider target and the default-looking action. Somebody who is not
 * sure should find it easier to refuse than to permit, and a refusal is
 * recoverable: the agent is told why and carries on with the rest of its task.
 */
export function ApprovalRequestCard({
  approval,
  onDecide,
}: {
  approval: ApprovalRequest;
  onDecide: (id: string, outcome: "allow" | "deny") => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const decide = async (outcome: "allow" | "deny") => {
    setBusy(true);
    try {
      await onDecide(approval.id, outcome);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-warning/40 bg-warning/5 p-3">
      <div className="flex items-start gap-2">
        <ShieldAlert
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-warning"
        />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm">
            Allow this {approval.toolName} call?
          </p>
          <p className="mt-0.5 text-base-content/60 text-xs">
            Paco stopped it because it {approval.reason}.
          </p>

          <pre className="mt-2 max-h-40 overflow-auto rounded bg-base-300/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed">
            {approval.detail}
          </pre>

          <div className="mt-3 flex gap-2">
            <Button
              disabled={busy}
              onClick={() => void decide("deny")}
              size="sm"
              variant="outline"
            >
              Don&apos;t allow
            </Button>
            <Button
              disabled={busy}
              onClick={() => void decide("allow")}
              size="sm"
              variant="destructive"
            >
              Allow once
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
