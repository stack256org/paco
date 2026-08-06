import { ShieldCheck } from "lucide-react";
import type { AdminUser } from "@/lib/admin/list-users";

/**
 * Formats a date the way the rest of Settings does — absolute, not relative.
 *
 * "3 months ago" is friendlier and useless here: an operator auditing who can
 * sign in wants a date they can compare against their own records.
 */
/**
 * A value only if there is something in it.
 *
 * better-auth stores a name it was never given as `""`, not NULL, so `??`
 * happily returns the empty string and the row renders with a blank name. The
 * same trap once made every git commit fail with "empty ident name".
 */
function present(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function formatDate(value: Date): string {
  return value.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function UsersTable({ users }: { users: AdminUser[] }) {
  return (
    // The table can exceed the panel on a narrow window; it scrolls inside its
    // own box rather than making the whole page scroll sideways.
    <div className="overflow-x-auto rounded-lg border border-base-300">
      <table className="table table-sm">
        <thead>
          <tr className="text-base-content/60">
            <th>User</th>
            <th>Email</th>
            <th>Joined</th>
            <th>Last signed in</th>
          </tr>
        </thead>
        <tbody>
          {/* Column headers over an empty body read as a broken page. An
              instance with one account is the normal case, not a failure. */}
          {users.length === 0 ? (
            <tr>
              <td className="py-8 text-center text-base-content/60" colSpan={4}>
                No one else has an account yet. People show up here once they
                sign in for the first time.
              </td>
            </tr>
          ) : null}
          {users.map((user) => (
            <tr key={user.id}>
              <td>
                <div className="flex items-center gap-2">
                  <span className="font-medium">
                    {present(user.name) ?? user.username}
                  </span>
                  {user.isAdmin && (
                    <span
                      className="badge badge-sm badge-soft badge-primary gap-1"
                      title="Administrator"
                    >
                      <ShieldCheck aria-hidden="true" className="size-3" />
                      Admin
                    </span>
                  )}
                </div>
              </td>
              {/* Sign-in is by magic link, so an account with no email cannot
                  be reached — worth showing plainly rather than as a blank. */}
              <td className="text-base-content/70">
                {present(user.email) ?? (
                  <span className="text-base-content/40">No email</span>
                )}
              </td>
              <td className="text-base-content/70">
                {formatDate(user.createdAt)}
              </td>
              <td className="text-base-content/70">
                {formatDate(user.lastLoginAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
