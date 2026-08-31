import { Settings } from "lucide-react";
import Link from "next/link";

/**
 * The one way into `/settings` from the application chrome.
 *
 * Deliberately just a link, not a menu: it used to live inside the account
 * menu alongside sign-out and the signed-in user's name, but there is no
 * account here any more, only a destination. A plain icon button is the
 * whole affordance Settings needs.
 */
export function SettingsLink() {
  return (
    <Link
      aria-label="Settings"
      className="btn btn-ghost btn-sm btn-square"
      href="/settings"
    >
      <Settings aria-hidden="true" className="size-4" />
    </Link>
  );
}
