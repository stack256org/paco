"use client";

import { AlertTriangle, Globe, Info, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  getInstanceSettings,
  updateAppDomain,
} from "@/lib/admin/instance-settings-actions";
import { toast } from "@/lib/toast";
import { emitDomainSaved } from "./domain-saved-signal";

type DomainFormState = {
  appDomain: string;
  tlsEnabled: boolean;
  previewBaseDomain: string;
};

type RestartResponse = {
  restarting?: boolean;
  error?: string;
};

function isRestartResponse(value: unknown): value is RestartResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.restarting === undefined ||
      typeof record.restarting === "boolean") &&
    (record.error === undefined || typeof record.error === "string")
  );
}

/**
 * Liveness polling for the restart button.
 *
 * The route answers before issuing the restart (see `route.ts`), so the
 * browser has no positive confirmation to wait for — it has to infer what
 * happened by polling a cheap, unauthenticated endpoint and watching for the
 * container to actually go away and come back:
 *
 * - `RESTART_POLL_INTERVAL_MS` — how often to check.
 * - `RESTART_POLL_REQUEST_TIMEOUT_MS` — abort a single check this fast, so a
 *   hanging socket (the usual symptom of a container mid-shutdown) can't
 *   stall the poll loop itself.
 * - `RESTART_NEVER_WENT_DOWN_TIMEOUT_MS` — if the server hasn't failed even
 *   once by this point, the restart very likely never happened (the `docker`
 *   binary missing, `HOSTNAME` not matching the real container name under
 *   compose/Swarm/Dokploy). That's the case that deserves the old, honest
 *   "couldn't confirm it" message.
 * - `RESTART_NOT_BACK_TIMEOUT_MS` — if it went down but hasn't come back by
 *   this point, say so distinctly rather than reusing the "never happened"
 *   message — the restart clearly was issued, it just hasn't finished.
 */
const RESTART_POLL_INTERVAL_MS = 1000;
const RESTART_POLL_REQUEST_TIMEOUT_MS = 3000;
const RESTART_NEVER_WENT_DOWN_TIMEOUT_MS = 30_000;
const RESTART_NOT_BACK_TIMEOUT_MS = 60_000;

/*
 * Guidance for someone running Paco from a checkout rather than the packaged
 * install, which is the case these two fields read least well for.
 *
 * The preview hint says "leave it blank" rather than offering a localhost
 * value, because there is no localhost value that works: previews are served
 * by nginx, from config Paco writes into `/etc/paco/nginx` and applies with
 * `nginx -t` + `systemctl reload nginx` (`lib/preview/nginx-reload.ts`). A
 * development checkout has none of that, so any preview domain entered here
 * would produce links that resolve to nothing. Saying so is more useful than
 * a value that looks like it should work.
 */
const LOCAL_ADDRESS_HINT =
  "Developing locally? Use http://localhost:3000 (or whatever port you run on).";
const LOCAL_PREVIEW_HINT =
  "Developing locally? Leave this blank. Previews are served by nginx, which a development checkout does not have, so no value here will work.";

/** The record an operator actually has to create, in the shape a DNS panel asks for. */
const PREVIEW_DNS_EXAMPLE = "*.previews.example.com.   A   203.0.113.10";

/** A single liveness check, bounded so a hanging socket can't stall the poll. */
async function pingServerAlive(): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    RESTART_POLL_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch("/api/auth/email-delivery", {
      cache: "no-store",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Where this Paco lives, and where its previews live.
 *
 * Certificates are not requested here — see `CertificateSection`. This section
 * used to claim it fetched them, which nothing in the product ever did.
 *
 * Saving here only ever writes to storage. better-auth reads its trusted-host
 * list once at process start, and `paco-entrypoint.sh` re-reads the saved
 * domain on boot — so a saved address is not a live one until the process
 * restarts. The section says "saved", never "applied" or "live", until that
 * restart happens, and it is the one place that offers to do it.
 */
/**
 * `onSaved`, when given, is called after every successful save with whether a
 * domain is now set — the same shape `SmtpSection` uses, and for the same
 * reason: the onboarding step that embeds this needs to know, and re-reading
 * the settings from the server just to learn what this component already knows
 * would race the write that caused it.
 */
export function DomainSection({
  onSaved,
}: {
  onSaved?: (hasDomain: boolean) => void;
} = {}) {
  const [form, setForm] = useState<DomainFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // Identifies which call to `loadSettings` is still the one worth acting on.
  // Bumped both by the cleanup below (the component unmounted, or is about to
  // re-run the effect) and implicitly superseded whenever a newer call starts
  // — so a response that lands after either can tell it is stale and skip
  // every `setForm`/`setLoadError`/`toast.error` it would otherwise fire.
  const requestIdRef = useRef(0);

  // The pending poll timer from the last restart attempt, so a second click
  // (or unmount) can cancel the previous one instead of leaving it to fire
  // against a component that has moved on.
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Identifies which restart attempt's poll loop is still worth acting on —
  // the same generation-counter pattern as `requestIdRef` above. Bumped by
  // the cleanup below and by the start of every new attempt, so a poll
  // response that lands after either can tell it is superseded and become a
  // no-op instead of reloading the page or toasting on a stale attempt.
  const restartGenerationRef = useRef(0);

  useEffect(
    () => () => {
      restartGenerationRef.current += 1;
      if (restartTimeoutRef.current !== null) {
        clearTimeout(restartTimeoutRef.current);
      }
    },
    [],
  );

  const loadSettings = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoadError(false);
    try {
      const settings = await getInstanceSettings();
      if (requestIdRef.current !== requestId) {
        return;
      }
      setForm({
        appDomain: settings.appDomain ?? "",
        previewBaseDomain: settings.previewBaseDomain ?? "",
        tlsEnabled: settings.tlsEnabled,
      });
    } catch {
      if (requestIdRef.current !== requestId) {
        return;
      }
      toast.error("We couldn't load the domain settings.");
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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form) {
      return;
    }

    setSaving(true);
    setJustSaved(false);

    try {
      const result = await updateAppDomain({
        appDomain: form.appDomain.trim() === "" ? null : form.appDomain.trim(),
        previewBaseDomain:
          form.previewBaseDomain.trim() === ""
            ? null
            : form.previewBaseDomain.trim(),
        tlsEnabled: form.tlsEnabled,
      });

      if (result.success) {
        toast.success("Domain settings saved.");
        setJustSaved(true);
        onSaved?.(form.appDomain.trim() !== "");
        // `CertificateSection` keys everything off whether a domain exists, so
        // it has to hear about this — otherwise it keeps telling the operator
        // to do the thing they just did.
        emitDomainSaved();
      } else {
        toast.error(result.error ?? "That didn't save. Try again.");
      }
    } catch {
      toast.error("That didn't save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  /**
   * Polls until the restart is confirmed one way or another, then either
   * reloads the page or re-enables the button with an honest message.
   *
   * `generation` ties every tick back to the attempt that started it — if a
   * newer attempt starts, or the component unmounts, `restartGenerationRef`
   * moves on and this becomes a no-op instead of acting on a stale attempt.
   * `wentDown` records whether any prior tick has already seen the server
   * unreachable; a success *after* that is what confirms the restart, as
   * opposed to a success because the restart never actually happened.
   */
  function pollForRestart(
    generation: number,
    startedAt: number,
    wentDown: boolean,
  ): void {
    restartTimeoutRef.current = setTimeout(() => {
      void (async () => {
        if (restartGenerationRef.current !== generation) {
          return;
        }

        const alive = await pingServerAlive();
        if (restartGenerationRef.current !== generation) {
          return;
        }

        const elapsedMs = Date.now() - startedAt;

        if (alive) {
          if (wentDown) {
            // Went away, then came back: the restart is confirmed. Reload
            // so the operator lands on the freshly-booted app rather than a
            // client still holding the pre-restart page.
            window.location.reload();
            return;
          }
          if (elapsedMs >= RESTART_NEVER_WENT_DOWN_TIMEOUT_MS) {
            // Never once failed — the restart very likely never happened.
            restartTimeoutRef.current = null;
            setRestarting(false);
            toast.error("Paco's restart could not be confirmed.", {
              description:
                "If this page is still loading normally, it did not come back on its own — restart it from the host with `sudo paco restart`.",
            });
            return;
          }
          pollForRestart(generation, startedAt, wentDown);
          return;
        }

        // Unreachable: the container is (or appears to be) down for the
        // restart.
        if (elapsedMs >= RESTART_NOT_BACK_TIMEOUT_MS) {
          restartTimeoutRef.current = null;
          setRestarting(false);
          toast.error(
            "Paco went down for the restart, but hasn't come back yet.",
            {
              description:
                "Check `paco logs`. If it stays down, restart it from the host with `sudo paco restart`.",
            },
          );
          return;
        }
        pollForRestart(generation, startedAt, true);
      })();
    }, RESTART_POLL_INTERVAL_MS);
  }

  async function handleRestart() {
    const generation = ++restartGenerationRef.current;
    if (restartTimeoutRef.current !== null) {
      clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }
    setRestarting(true);

    try {
      const response = await fetch("/api/admin/restart", { method: "POST" });
      const body: unknown = await response.json();

      if (restartGenerationRef.current !== generation) {
        return;
      }

      if (!isRestartResponse(body)) {
        toast.error("Paco could not be restarted.");
        setRestarting(false);
        return;
      }

      if (body.restarting) {
        toast.info("Restarting Paco…", {
          description:
            "This page will be unavailable for a few seconds while the container comes back up.",
        });
        // The request answers before the container actually restarts (see
        // route.ts), so polling a cheap, unauthenticated endpoint is the
        // only feedback loop the browser has for what actually happened.
        pollForRestart(generation, Date.now(), false);
      } else {
        toast.error(body.error ?? "Paco could not be restarted.");
        setRestarting(false);
      }
    } catch {
      if (restartGenerationRef.current !== generation) {
        return;
      }
      toast.error("Paco could not be restarted.");
      setRestarting(false);
    }
  }

  return (
    <section className="rounded-lg border border-base-content/10">
      <div className="border-base-content/10 border-b px-5 py-4">
        <h2 className="flex items-center gap-2 font-semibold text-base">
          <Globe aria-hidden="true" className="size-4" />
          Domain
        </h2>
        <p className="mt-1 text-base-content/60 text-sm">
          The address people use to reach this Paco, and the base domain preview
          links are built from.
        </p>
      </div>

      <div className="px-5 py-4">
        {loadError ? (
          <div className="alert alert-error alert-soft" role="alert">
            <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
            <span>Domain settings couldn&apos;t be loaded.</span>
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
            <label className="label" htmlFor="app-domain">
              Address
              <span
                className="tooltip tooltip-right"
                data-tip={LOCAL_ADDRESS_HINT}
              >
                <Info aria-hidden="true" className="size-3.5 opacity-60" />
                <span className="sr-only">{LOCAL_ADDRESS_HINT}</span>
              </span>
            </label>
            <input
              className="input input-sm w-full"
              disabled={form === null || saving}
              id="app-domain"
              onChange={(event) =>
                setForm((prev) =>
                  prev ? { ...prev, appDomain: event.target.value } : prev,
                )
              }
              placeholder="https://paco.example.com"
              type="text"
              value={form?.appDomain ?? ""}
            />
            <p className="text-base-content/60 text-xs">
              The full origin people use to reach Paco, including{" "}
              <code>https://</code>. This is what invitation and sign-in links
              are built from.
            </p>

            <label className="label" htmlFor="preview-base-domain">
              Preview domain
              <span
                className="tooltip tooltip-right"
                data-tip={LOCAL_PREVIEW_HINT}
              >
                <Info aria-hidden="true" className="size-3.5 opacity-60" />
                <span className="sr-only">{LOCAL_PREVIEW_HINT}</span>
              </span>
            </label>
            <input
              className="input input-sm w-full"
              disabled={form === null || saving}
              id="preview-base-domain"
              onChange={(event) =>
                setForm((prev) =>
                  prev
                    ? { ...prev, previewBaseDomain: event.target.value }
                    : prev,
                )
              }
              placeholder="previews.example.com"
              type="text"
              value={form?.previewBaseDomain ?? ""}
            />
            <p className="text-base-content/60 text-xs">
              A bare domain, no scheme. Every chat gets its own subdomain of it
              — <code>a1b2c3.previews.example.com</code> — so this needs a{" "}
              <strong>wildcard</strong> DNS record pointing at this host, not a
              single one:
            </p>
            <pre className="overflow-x-auto rounded bg-base-200 px-3 py-2 text-xs">
              <code>{PREVIEW_DNS_EXAMPLE}</code>
            </pre>
            <p className="text-base-content/60 text-xs">
              Without the wildcard the domain itself resolves but every preview
              link does not, which looks like previews being broken rather than
              a record being missing. Leave this blank to turn previews off.
            </p>

            <label className="label mt-2">
              <input
                checked={form?.tlsEnabled ?? false}
                className="toggle toggle-sm"
                disabled={form === null || saving}
                onChange={(event) =>
                  setForm((prev) =>
                    prev ? { ...prev, tlsEnabled: event.target.checked } : prev,
                  )
                }
                type="checkbox"
              />
              Serve previews over HTTPS
            </label>
            <p className="text-base-content/60 text-xs">
              Only turn this on once each preview hostname has a certificate in{" "}
              <code>/etc/paco/preview-certs</code>. Previews without one stay on
              HTTP rather than breaking.
            </p>

            <button
              className="btn btn-sm mt-4 w-fit"
              disabled={form === null || saving}
              type="submit"
            >
              {saving ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              ) : null}
              {saving ? "Saving…" : "Save domain"}
            </button>
          </form>
        )}

        {justSaved ? (
          <div className="alert alert-warning alert-soft mt-4" role="alert">
            <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
            <div>
              <p>
                The new address is saved, but not yet in effect — the running
                process still trusts the old one. Restart Paco to pick it up.
              </p>
            </div>
            <button
              className="btn btn-sm btn-warning"
              disabled={restarting}
              onClick={() => void handleRestart()}
              type="button"
            >
              {restarting ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              ) : null}
              {restarting ? "Restarting…" : "Restart now"}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
