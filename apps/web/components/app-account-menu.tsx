"use client";

import { LogOut, Settings } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useSignOutConfirm } from "@/hooks/use-sign-out-confirm";
import type { Session as AuthSession } from "@/lib/session/types";

/**
 * The signed-in account, and everything that used to sit in the sidebar's
 * footer: settings, the theme control, and signing out.
 *
 * Grouped behind the avatar rather than spread across the bar because none of
 * it is part of the work — it is visited rarely and deliberately, and a top bar
 * that shows every rare action loses the room for the frequent ones.
 */

function initialsOf(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 2).toUpperCase() : "?";
}

export function AppAccountMenu({ user }: { user?: AuthSession["user"] }) {
  const router = useRouter();
  const { requestSignOut, dialog: signOutDialog } = useSignOutConfirm();
  const menuId = useId();
  const anchorName = `--${menuId.replace(/[^a-zA-Z0-9-]/g, "")}-anchor`;

  if (!user) {
    return null;
  }

  const displayName = user.username || user.email || "Account";

  return (
    <>
      <button
        aria-label={`Account menu for ${displayName}`}
        className="btn btn-ghost btn-sm btn-square"
        popoverTarget={menuId}
        style={{ anchorName } as React.CSSProperties}
        type="button"
      >
        <Avatar className="size-6">
          <AvatarFallback className="text-[10px]">
            {initialsOf(displayName)}
          </AvatarFallback>
        </Avatar>
      </button>

      <div
        className="dropdown dropdown-end w-60 rounded-box border border-base-300 bg-base-100 shadow-lg"
        id={menuId}
        popover="auto"
        style={{ positionAnchor: anchorName } as React.CSSProperties}
      >
        <div className="border-base-300 border-b px-3 py-2">
          <p className="truncate font-medium text-sm">{displayName}</p>
          {user.email ? (
            <p className="truncate text-base-content/60 text-xs">
              {user.email}
            </p>
          ) : null}
        </div>

        <ul className="menu menu-sm w-full p-1">
          <li>
            <button
              className="gap-2"
              onClick={() => router.push("/settings")}
              popoverTarget={menuId}
              popoverTargetAction="hide"
              type="button"
            >
              <Settings aria-hidden="true" className="size-4" />
              Settings
            </button>
          </li>
          <li>
            <button
              className="gap-2"
              onClick={() => void requestSignOut()}
              popoverTarget={menuId}
              popoverTargetAction="hide"
              type="button"
            >
              <LogOut aria-hidden="true" className="size-4" />
              Sign out
            </button>
          </li>
        </ul>

        <div className="flex items-center justify-between gap-2 border-base-300 border-t px-3 py-2">
          <span className="text-base-content/60 text-xs">Theme</span>
          <ThemeToggle />
        </div>
      </div>

      {/* Outside the popover, which hides as soon as Sign out is pressed — a
          question rendered inside it would be dismissed along with it. */}
      {signOutDialog}
    </>
  );
}
