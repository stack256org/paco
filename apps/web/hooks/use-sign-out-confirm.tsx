"use client";

import { useCallback } from "react";
import { signOut } from "@/lib/auth/actions";
import { useDestructiveConfirm } from "./use-destructive-confirm";

/**
 * Signing out, with a question first.
 *
 * Nothing is destroyed by signing out, so this is not styled as destruction.
 * It asks because of how getting back in works here: there is no password, so
 * the way back is a link mailed to an address, and on an instance whose mail is
 * not configured that link only ever reaches the server log. "Sign out" also
 * sits in a menu directly under ordinary navigation, one slip away from
 * Settings, which is exactly where an unasked one-click exit does most damage.
 *
 * A hook because the three places that offer it — the settings sidebar, its
 * mobile sheet, and the account menu in the top bar — render the control
 * themselves and differ in every way except what the button does.
 */
export function useSignOutConfirm() {
  const { confirm, dialog } = useDestructiveConfirm();

  const requestSignOut = useCallback(async () => {
    const confirmed = await confirm({
      confirmLabel: "Sign out",
      description:
        "Nothing is deleted: your workspaces, your chats and the files in them are all still here when you come back. To get back in you enter your email address and open the link Paco sends you, so you will need to be able to read that inbox.",
      destructive: false,
      title: "Sign out?",
    });

    if (confirmed) {
      // The action redirects, so there is no "signing out…" state to hold —
      // the page it lands on is the feedback.
      await signOut();
    }
  }, [confirm]);

  return { requestSignOut, dialog };
}
