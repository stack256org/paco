"use client";

import { AlertTriangle, Loader2, Mail, UserPlus, XCircle } from "lucide-react";
import Link from "next/link";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  getPendingInvitations,
  inviteMember,
  revokeMemberInvitation,
} from "@/lib/admin/invitation-actions";
import type { PendingInvitation } from "@/lib/org/invitations";
import { toast } from "@/lib/toast";

type Role = "admin" | "member";

function formatExpiry(value: Date): string {
  return value.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Invite people to the organisation.
 *
 * Paco has no open sign-up — an invitation is the only way anyone but the
 * first account gets in — so this is the entire "add a user" flow, not one
 * option among several.
 */
export function InviteSection() {
  const [invitations, setInvitations] = useState<PendingInvitation[] | null>(
    null,
  );
  const [loadError, setLoadError] = useState(false);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [inviting, setInviting] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  // `null` until the instance has been asked whether it can send mail at
  // all. Undecided is treated as "can send", same as `SignInButton`, so a
  // slow or failed probe never blocks the form on an instance whose email
  // works fine.
  const [deliversEmail, setDeliversEmail] = useState<boolean | null>(null);

  const requestIdRef = useRef(0);

  const loadInvitations = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoadError(false);
    try {
      const rows = await getPendingInvitations();
      if (requestIdRef.current !== requestId) {
        return;
      }
      setInvitations(rows);
    } catch {
      if (requestIdRef.current !== requestId) {
        return;
      }
      toast.error("We couldn't load pending invitations.");
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void loadInvitations();
    return () => {
      requestIdRef.current += 1;
    };
  }, [loadInvitations]);

  useEffect(() => {
    let cancelled = false;

    async function checkDelivery() {
      try {
        const response = await fetch("/api/auth/email-delivery");
        if (!response.ok) {
          return;
        }
        const body = (await response.json()) as { deliversEmail?: boolean };
        if (!cancelled) {
          setDeliversEmail(body.deliversEmail !== false);
        }
      } catch {
        // Assume it works; the honest-but-wrong direction is the safer one.
      }
    }

    void checkDelivery();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || inviting) {
      return;
    }

    setInviting(true);
    try {
      const result = await inviteMember({ email: trimmed, role });
      if (result.success) {
        toast.success(`Invitation sent to ${trimmed}.`);
        setEmail("");
        setRole("member");
        await loadInvitations();
      } else {
        toast.error(result.error ?? "That invitation could not be sent.");
      }
    } catch {
      toast.error("That invitation could not be sent.");
    } finally {
      setInviting(false);
    }
  }

  async function handleRevoke(invitation: PendingInvitation) {
    setRevokingId(invitation.id);
    // Optimistic: a revoked invitation should disappear immediately, not
    // wait on a round trip the admin has no reason to doubt the result of.
    const previous = invitations;
    setInvitations((rows) =>
      rows ? rows.filter((row) => row.id !== invitation.id) : rows,
    );

    try {
      const result = await revokeMemberInvitation(invitation.id);
      if (!result.success) {
        setInvitations(previous);
        toast.error(result.error ?? "That invitation could not be revoked.");
      }
    } catch {
      setInvitations(previous);
      toast.error("That invitation could not be revoked.");
    } finally {
      setRevokingId(null);
    }
  }

  const canSubmit = !inviting && email.trim() !== "" && deliversEmail !== false;

  return (
    <section className="rounded-lg border border-base-content/10">
      <div className="border-base-content/10 border-b px-5 py-4">
        <h2 className="flex items-center gap-2 font-semibold text-base">
          <UserPlus aria-hidden="true" className="size-4" />
          Invite people
        </h2>
        <p className="mt-1 text-base-content/60 text-sm">
          This instance is invitation-only — sending an invitation is the only
          way anyone besides you gets an account.
        </p>
      </div>

      <div className="space-y-5 px-5 py-4">
        {deliversEmail === false ? (
          <div className="alert alert-warning alert-soft" role="alert">
            <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
            <span>
              Paco can&rsquo;t send email yet, so an invitation would go
              nowhere.{" "}
              <Link
                className="link link-hover font-medium"
                href="/settings/admin"
              >
                Set up a mail server in Settings
              </Link>
              , then come back here.
            </span>
          </div>
        ) : null}

        <form
          className="fieldset"
          onSubmit={(event) => void handleInvite(event)}
        >
          <legend className="fieldset-legend sr-only">
            Invite someone by email
          </legend>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <label className="label" htmlFor="invite-email">
                Email
              </label>
              <input
                autoComplete="off"
                className="input input-sm w-full"
                disabled={inviting}
                id="invite-email"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="teammate@example.com"
                type="email"
                value={email}
              />
            </div>

            <div>
              <label className="label" htmlFor="invite-role">
                Role
              </label>
              <select
                className="select select-sm w-full sm:w-auto"
                disabled={inviting}
                id="invite-role"
                onChange={(event) => setRole(event.target.value as Role)}
                value={role}
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </div>

            <button
              className="btn btn-sm w-fit"
              disabled={!canSubmit}
              type="submit"
            >
              {inviting ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              ) : (
                <Mail aria-hidden="true" className="size-4" />
              )}
              {inviting ? "Sending…" : "Invite"}
            </button>
          </div>
        </form>

        <div className="border-base-content/10 border-t pt-4">
          <h3 className="font-medium text-sm">Pending invitations</h3>

          {loadError ? (
            <div className="alert alert-error alert-soft mt-3" role="alert">
              <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
              <span>Pending invitations couldn&apos;t be loaded.</span>
              <button
                className="btn btn-sm"
                onClick={() => void loadInvitations()}
                type="button"
              >
                Try again
              </button>
            </div>
          ) : (
            <div className="mt-3 max-w-full overflow-x-auto rounded-lg border border-base-content/10">
              <table className="table table-sm">
                <thead>
                  <tr className="text-base-content/60">
                    <th>Email</th>
                    <th>Role</th>
                    <th>Expires</th>
                    <th className="text-right">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invitations === null ? (
                    <tr>
                      <td
                        className="py-6 text-center text-base-content/60"
                        colSpan={4}
                      >
                        Loading…
                      </td>
                    </tr>
                  ) : null}
                  {invitations?.length === 0 ? (
                    <tr>
                      <td
                        className="py-6 text-center text-base-content/60"
                        colSpan={4}
                      >
                        No pending invitations.
                      </td>
                    </tr>
                  ) : null}
                  {invitations?.map((invitation) => (
                    <tr key={invitation.id}>
                      <td className="text-base-content/80">
                        {invitation.email}
                      </td>
                      <td>
                        <span className="badge badge-sm badge-soft">
                          {invitation.role === "admin" ? "Admin" : "Member"}
                        </span>
                      </td>
                      <td className="text-base-content/70">
                        {formatExpiry(invitation.expiresAt)}
                      </td>
                      <td className="text-right">
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={revokingId === invitation.id}
                          onClick={() => void handleRevoke(invitation)}
                          type="button"
                        >
                          {revokingId === invitation.id ? (
                            <Loader2
                              aria-hidden="true"
                              className="size-4 animate-spin"
                            />
                          ) : (
                            <XCircle aria-hidden="true" className="size-4" />
                          )}
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
