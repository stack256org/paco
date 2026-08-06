"use client";

import { AlertTriangle, CheckCircle2, Loader2, Mail } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useSession } from "@/hooks/use-session";
import {
  getInstanceSettings,
  sendTestEmail,
  updateSmtpSettings,
} from "@/lib/admin/instance-settings-actions";
import { toast } from "@/lib/toast";

type EncryptionOption = "automatic" | "starttls" | "tls";

type SmtpFormState = {
  host: string;
  port: string;
  encryption: EncryptionOption;
  user: string;
  /** Always starts empty — the server never sends the stored password back. */
  password: string;
  from: string;
};

type TestResult = {
  ok: boolean;
  message: string;
};

function encryptionFromSecure(secure: boolean | null): EncryptionOption {
  if (secure === true) {
    return "tls";
  }
  if (secure === false) {
    return "starttls";
  }
  return "automatic";
}

function secureFromEncryption(encryption: EncryptionOption): boolean | null {
  if (encryption === "tls") {
    return true;
  }
  if (encryption === "starttls") {
    return false;
  }
  return null;
}

/**
 * The mail server invitations go out through.
 *
 * The password field never receives the stored password — `getInstanceSettings`
 * only reports whether one exists. It renders empty with a placeholder saying
 * so, and an untouched, empty submission is normalised by `smtpSchema` to
 * `null`, which `saveSmtpSettings` treats as "leave the stored password
 * alone". There is no client-side special-casing here; the schema already
 * does the right thing with a blank field.
 *
 * `onSaved`, when given, is called after every successful save with whether
 * a host is now set. The guided onboarding flow (`app/onboarding`) uses this
 * to keep its own "still needs a mail server" messaging accurate the moment
 * an operator saves — without it, the message would only catch up on a page
 * reload.
 */
export function SmtpSection({
  onSaved,
}: {
  onSaved?: (hasHost: boolean) => void;
} = {}) {
  const { session } = useSession();
  const [form, setForm] = useState<SmtpFormState | null>(null);
  const [hasStoredPassword, setHasStoredPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [portError, setPortError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  // Identifies which call to `loadSettings` is still the one worth acting on.
  // Bumped both by the cleanup below (the component unmounted, or is about to
  // re-run the effect) and implicitly superseded whenever a newer call starts
  // — so a response that lands after either can tell it is stale and skip
  // every `setForm`/`setHasStoredPassword`/`setLoadError`/`toast.error` it
  // would otherwise fire.
  const requestIdRef = useRef(0);

  const [testTo, setTestTo] = useState("");
  const [testToTouched, setTestToTouched] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const loadSettings = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoadError(false);
    try {
      const settings = await getInstanceSettings();
      if (requestIdRef.current !== requestId) {
        return;
      }
      setForm({
        encryption: encryptionFromSecure(settings.smtp.secure),
        from: settings.smtp.from ?? "",
        host: settings.smtp.host ?? "",
        password: "",
        port: settings.smtp.port === null ? "" : String(settings.smtp.port),
        user: settings.smtp.user ?? "",
      });
      setHasStoredPassword(settings.smtp.hasPassword);
    } catch {
      if (requestIdRef.current !== requestId) {
        return;
      }
      toast.error("We couldn't load the mail server settings.");
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
    return () => {
      // Invalidate whatever request this mount has in flight, so its
      // continuation (if it resolves after unmount) is a no-op.
      requestIdRef.current += 1;
    };
  }, [loadSettings]);

  // Default the test-email address to the signed-in administrator's own,
  // unless they have already typed something in.
  useEffect(() => {
    if (!testToTouched && session?.user?.email) {
      setTestTo(session.user.email);
    }
  }, [session?.user?.email, testToTouched]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form) {
      return;
    }

    const trimmedPort = form.port.trim();
    let port: number | null = null;
    if (trimmedPort !== "") {
      if (!/^\d+$/.test(trimmedPort)) {
        setPortError("Port must be a whole number, e.g. 587.");
        return;
      }
      port = Number(trimmedPort);
    }
    setPortError(null);

    setSaving(true);

    try {
      const result = await updateSmtpSettings({
        from: form.from.trim() === "" ? null : form.from.trim(),
        host: form.host.trim() === "" ? null : form.host.trim(),
        password: form.password,
        port,
        secure: secureFromEncryption(form.encryption),
        user: form.user.trim() === "" ? null : form.user.trim(),
      });

      if (result.success) {
        toast.success("Mail server settings saved.");
        // The stored password (if any changed) is never sent back down, so
        // clear the field and re-derive whether one is now stored from what
        // was just submitted.
        setForm((prev) => (prev ? { ...prev, password: "" } : prev));
        if (form.password.trim() !== "") {
          setHasStoredPassword(true);
        }
        onSaved?.(form.host.trim() !== "");
      } else {
        toast.error(result.error ?? "That didn't save. Try again.");
      }
    } catch {
      toast.error("That didn't save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSendTest() {
    setSendingTest(true);
    setTestResult(null);

    try {
      const result = await sendTestEmail(testTo);
      if (result.success) {
        setTestResult({ message: `Sent to ${testTo}.`, ok: true });
      } else {
        // The whole point of this button is to surface the mail server's own
        // words — "535 authentication failed", "certificate has expired" —
        // verbatim, not a generic sentence in its place.
        setTestResult({
          message: result.error ?? "The mail server refused the message.",
          ok: false,
        });
      }
    } catch {
      setTestResult({
        message: "The request to send a test email failed.",
        ok: false,
      });
    } finally {
      setSendingTest(false);
    }
  }

  return (
    <section className="rounded-lg border border-base-content/10">
      <div className="border-base-content/10 border-b px-5 py-4">
        <h2 className="flex items-center gap-2 font-semibold text-base">
          <Mail aria-hidden="true" className="size-4" />
          Mail server
        </h2>
        <p className="mt-1 text-base-content/60 text-sm">
          This is what invitations are delivered with — set it up before
          inviting anyone.
        </p>
      </div>

      <div className="space-y-5 px-5 py-4">
        {loadError ? (
          <div className="alert alert-error alert-soft" role="alert">
            <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
            <span>Mail server settings couldn&apos;t be loaded.</span>
            <button
              className="btn btn-sm"
              onClick={() => void loadSettings()}
              type="button"
            >
              Try again
            </button>
          </div>
        ) : (
          <form
            className="fieldset"
            onSubmit={(event) => void handleSubmit(event)}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="smtp-host">
                  Host
                </label>
                <input
                  className="input input-sm w-full"
                  disabled={form === null || saving}
                  id="smtp-host"
                  onChange={(event) =>
                    setForm((prev) =>
                      prev ? { ...prev, host: event.target.value } : prev,
                    )
                  }
                  placeholder="smtp.example.com"
                  type="text"
                  value={form?.host ?? ""}
                />
                <p className="label">
                  Saving a host here makes Settings the only source — any SMTP_*
                  environment variables are ignored entirely, so username and
                  password must be entered below too, even if they&apos;re
                  already set in the environment.
                </p>
              </div>

              <div>
                <label className="label" htmlFor="smtp-port">
                  Port
                </label>
                <input
                  aria-describedby={portError ? "smtp-port-error" : undefined}
                  aria-invalid={portError ? true : undefined}
                  className={
                    portError
                      ? "input input-sm w-full input-error"
                      : "input input-sm w-full"
                  }
                  disabled={form === null || saving}
                  id="smtp-port"
                  inputMode="numeric"
                  onChange={(event) => {
                    setPortError(null);
                    setForm((prev) =>
                      prev ? { ...prev, port: event.target.value } : prev,
                    );
                  }}
                  placeholder="587"
                  type="text"
                  value={form?.port ?? ""}
                />
                {portError ? (
                  <p className="label text-error" id="smtp-port-error">
                    {portError}
                  </p>
                ) : null}
              </div>
            </div>

            <label className="label" htmlFor="smtp-encryption">
              Encryption
            </label>
            <select
              className="select select-sm w-full sm:w-auto"
              disabled={form === null || saving}
              id="smtp-encryption"
              onChange={(event) =>
                setForm((prev) =>
                  prev
                    ? {
                        ...prev,
                        encryption: event.target.value as EncryptionOption,
                      }
                    : prev,
                )
              }
              value={form?.encryption ?? "automatic"}
            >
              <option value="automatic">Automatic</option>
              <option value="tls">TLS on connect</option>
              <option value="starttls">STARTTLS</option>
            </select>
            <p className="label">
              Automatic picks TLS for port 465 and STARTTLS otherwise.
            </p>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="smtp-user">
                  Username
                </label>
                <input
                  className="input input-sm w-full"
                  disabled={form === null || saving}
                  id="smtp-user"
                  onChange={(event) =>
                    setForm((prev) =>
                      prev ? { ...prev, user: event.target.value } : prev,
                    )
                  }
                  type="text"
                  value={form?.user ?? ""}
                />
              </div>

              <div>
                <label className="label" htmlFor="smtp-password">
                  Password
                </label>
                <input
                  autoComplete="new-password"
                  className="input input-sm w-full"
                  disabled={form === null || saving}
                  id="smtp-password"
                  onChange={(event) =>
                    setForm((prev) =>
                      prev ? { ...prev, password: event.target.value } : prev,
                    )
                  }
                  placeholder={
                    hasStoredPassword
                      ? "A password is already stored — leave blank to keep it"
                      : ""
                  }
                  type="password"
                  value={form?.password ?? ""}
                />
              </div>
            </div>

            <label className="label" htmlFor="smtp-from">
              From address
            </label>
            <input
              className="input input-sm w-full"
              disabled={form === null || saving}
              id="smtp-from"
              placeholder="paco@example.com"
              onChange={(event) =>
                setForm((prev) =>
                  prev ? { ...prev, from: event.target.value } : prev,
                )
              }
              type="text"
              value={form?.from ?? ""}
            />

            <button
              className="btn btn-sm mt-4 w-fit"
              disabled={form === null || saving}
              type="submit"
            >
              {saving ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              ) : null}
              {saving ? "Saving…" : "Save mail server"}
            </button>
          </form>
        )}

        <div className="border-base-content/10 border-t pt-4">
          <h3 className="font-medium text-sm">Send a test email</h3>
          <p className="mt-1 text-base-content/60 text-xs">
            Proves the settings above actually work, before an invitation
            depends on them.
          </p>

          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              aria-label="Send test email to"
              className="input input-sm w-full sm:max-w-xs"
              onChange={(event) => {
                setTestToTouched(true);
                setTestTo(event.target.value);
              }}
              placeholder="you@example.com"
              type="email"
              value={testTo}
            />
            <button
              className="btn btn-sm btn-outline w-fit"
              disabled={sendingTest || testTo.trim() === ""}
              onClick={() => void handleSendTest()}
              type="button"
            >
              {sendingTest ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              ) : null}
              {sendingTest ? "Sending…" : "Send test email"}
            </button>
          </div>

          {testResult ? (
            <div
              className={
                testResult.ok
                  ? "alert alert-success alert-soft mt-3"
                  : "alert alert-error alert-soft mt-3"
              }
              role="alert"
            >
              {testResult.ok ? (
                <CheckCircle2 aria-hidden="true" className="size-4 shrink-0" />
              ) : (
                <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
              )}
              <span>{testResult.message}</span>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
