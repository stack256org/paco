"use client";

import type { CSSProperties } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import type { Session as AuthSession } from "@/lib/session/types";

/**
 * The button that opens the account menu in the top bar.
 *
 * Split out of `AppAccountMenu` for the same reason `ConsentForm` is split out
 * of `ConsentDialog`: the menu itself needs `useRouter` and a confirm dialog,
 * neither of which renders outside a browser, and this is the part whose
 * markup has to be pinned by a test.
 *
 * It shows the name next to the avatar. An unlabelled avatar was the only door
 * to Settings on this instance and people were not finding it — a face with no
 * name does not read as "your account", so nobody clicked it. The name is
 * inside the button rather than beside it so the target grows instead of
 * splitting in two.
 */

function initialsOf(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 2).toUpperCase() : "?";
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * What to call this person in the bar.
 *
 * `name` is the real name and is nullable; `username` is required on the row
 * but is itself derived from the email's local part at sign-up
 * (`lib/auth/username.ts`), so it is a handle rather than a name. The address
 * is the last resort, and its local part is preferred over the whole thing —
 * a top bar is not wide enough to spend on a domain everyone here shares.
 *
 * Never returns an empty string: a button whose label collapses to nothing is
 * the bug this change exists to fix.
 */
export function resolveAccountDisplayName(
  user: Partial<AuthSession["user"]> | undefined,
): string {
  const email = nonEmpty(user?.email);
  return (
    nonEmpty(user?.name) ??
    nonEmpty(user?.username) ??
    (email ? (nonEmpty(email.split("@", 1)[0]) ?? email) : null) ??
    "Account"
  );
}

export type AccountMenuTriggerProps = {
  /** Already resolved by `resolveAccountDisplayName`. */
  displayName: string;
  /** `id` of the popover this button opens. */
  popoverTarget: string;
  /** CSS anchor name shared with the popover. */
  anchorName: string;
};

export function AccountMenuTrigger({
  anchorName,
  displayName,
  popoverTarget,
}: AccountMenuTriggerProps) {
  return (
    <button
      // The visible name is part of this label rather than a second one, so a
      // screen reader hears "Account menu for Ada" once — not the name twice,
      // and not a label that disagrees with what is on screen when the text is
      // hidden at narrow widths.
      aria-label={`Account menu for ${displayName}`}
      className="btn btn-ghost btn-sm max-w-40 px-2"
      popoverTarget={popoverTarget}
      style={{ anchorName } as CSSProperties}
      type="button"
    >
      <Avatar className="size-6 shrink-0">
        <AvatarFallback className="text-[10px]">
          {initialsOf(displayName)}
        </AvatarFallback>
      </Avatar>
      {/* `min-w-0` is what lets `truncate` actually bite: a flex item's
          min-width is `auto`, so without it a long address pushes the button
          past `max-w-40` and shoves the rest of the bar off-screen. Hidden
          below `sm`, where the bar has no width to spare — the avatar and the
          aria-label still carry the control there. */}
      <span className="hidden min-w-0 truncate font-normal text-sm sm:block">
        {displayName}
      </span>
    </button>
  );
}
