"use client";

import { Button } from "@/components/ui/button";

export type ApprovalButtonsProps = {
  approvalId: string;
  onApprove?: (id: string) => void;
  onDeny?: (id: string, reason?: string) => void;
};

export function ApprovalButtons({
  approvalId,
  onApprove,
  onDeny,
}: ApprovalButtonsProps) {
  return (
    <div className="mt-3 flex items-center gap-2 pl-5">
      <Button
        size="sm"
        variant="outline"
        className="h-7 border-success text-success hover:bg-success hover:text-base-content"
        onClick={() => onApprove?.(approvalId)}
      >
        Approve
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-7 border-error text-error hover:bg-error hover:text-base-content"
        onClick={() => onDeny?.(approvalId)}
      >
        Deny
      </Button>
    </div>
  );
}
