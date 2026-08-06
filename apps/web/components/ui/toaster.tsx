"use client";

import { Toast } from "@base-ui/react/toast";
import { XIcon } from "lucide-react";
import { toastManager } from "@/lib/toast";

/**
 * Toast viewport, styled with daisyUI's `toast` and `alert`.
 *
 * Colour follows the toast's type so status is not carried by wording alone, and
 * the icon-free `alert-soft` treatment keeps a run notification from shouting
 * over the console it sits on top of.
 */
const TYPE_CLASS: Record<string, string> = {
  success: "alert-success",
  error: "alert-error",
  info: "alert-info",
  warning: "alert-warning",
};

function ToastList() {
  const { toasts } = Toast.useToastManager();

  return toasts.map((toast) => (
    <Toast.Root
      className={[
        "alert alert-soft w-80 gap-2 border border-base-300 shadow-lg",
        "transition-all duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0",
        "data-ending-style:translate-x-4 data-starting-style:translate-x-4",
        toast.type ? (TYPE_CLASS[toast.type] ?? "") : "",
      ]
        .filter(Boolean)
        .join(" ")}
      key={toast.id}
      toast={toast}
    >
      <div className="min-w-0 flex-1">
        <Toast.Title className="text-sm font-medium" />
        <Toast.Description className="text-xs opacity-80" />
      </div>
      {/* Base UI only renders the action when the toast supplied one. */}
      <Toast.Action className="btn btn-ghost btn-xs" />
      <Toast.Close aria-label="Dismiss" className="btn btn-ghost btn-xs btn-circle">
        <XIcon className="size-3.5" />
      </Toast.Close>
    </Toast.Root>
  ));
}

export function Toaster() {
  return (
    <Toast.Provider toastManager={toastManager}>
      <Toast.Portal>
        <Toast.Viewport className="toast toast-end toast-bottom z-100">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
