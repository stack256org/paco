import { Toast } from "@base-ui/react/toast";

/**
 * Imperative toast API.
 *
 * Replaces `sonner`. Base UI's toast manager can be created outside React, which
 * is what lets the seven call sites keep calling `toast.error(...)` from event
 * handlers and hooks instead of threading a hook through each one.
 *
 * The option shape mirrors what those call sites already pass — `description`,
 * `duration`, and a single `action` — so none of them changed. `position` is
 * accepted and ignored: the viewport owns placement, and one toast asking to be
 * somewhere else was cosmetic rather than meaningful.
 */

export const toastManager = Toast.createToastManager();

export interface ToastOptions {
  description?: string;
  duration?: number;
  action?: { label: string; onClick: () => void };
  /** Accepted for source compatibility; the viewport decides placement. */
  position?: string;
}

type ToastType = "success" | "error" | "info";

function add(
  title: string,
  type: ToastType | undefined,
  options?: ToastOptions,
) {
  return toastManager.add({
    title,
    ...(options?.description ? { description: options.description } : {}),
    ...(type ? { type } : {}),
    ...(options?.duration === undefined ? {} : { timeout: options.duration }),
    ...(options?.action
      ? {
          actionProps: {
            children: options.action.label,
            onClick: options.action.onClick,
          },
        }
      : {}),
  });
}

export const toast = Object.assign(
  (title: string, options?: ToastOptions) => add(title, undefined, options),
  {
    success: (title: string, options?: ToastOptions) =>
      add(title, "success", options),
    error: (title: string, options?: ToastOptions) =>
      add(title, "error", options),
    info: (title: string, options?: ToastOptions) =>
      add(title, "info", options),
    dismiss: (id?: string) => toastManager.close(id),
  },
);
