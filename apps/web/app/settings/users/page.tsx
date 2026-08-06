import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { listUsers } from "@/lib/admin/list-users";
import { isAdmin } from "@/lib/admin/require-admin";
import { getServerSession } from "@/lib/session/get-server-session";
import { InviteSection } from "./invite-section";
import { UsersTable } from "./users-table";

export const metadata: Metadata = {
  title: "Users",
  description: "Everyone with an account on this Paco instance.",
};

/**
 * Who can sign in to this instance — as distinct from Profile, which is your
 * own account and nobody else's. The two were conflated before: the Users
 * entry led straight to Profile, so there was no way to see the second thing.
 *
 * A server component because the answer comes from the database and must not
 * be reachable without the admin check; `notFound()` rather than a redirect so
 * a non-admin learns nothing about whether the page exists.
 */
export default async function UsersPage() {
  const session = await getServerSession();

  if (!session?.user?.id || !(await isAdmin(session.user.id))) {
    notFound();
  }

  const users = await listUsers();

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Users</h1>
        <p className="mt-1 text-sm text-base-content/60">
          {users.length === 1
            ? "1 account on this instance."
            : `${users.length} accounts on this instance.`}
        </p>
      </div>

      <InviteSection />

      <UsersTable users={users} />
    </>
  );
}
