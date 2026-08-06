"use client";

import { AlertTriangle, Loader2, Lock, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CertificateStatus,
  getCertificateStatus,
  requestCertificate,
} from "@/lib/admin/tls-actions";
import { toast } from "@/lib/toast";
import { onDomainSaved } from "./domain-saved-signal";

/**
 * Obtaining a TLS certificate, on request, from Settings.
 *
 * A separate section from `DomainSection` rather than another control inside
 * it, for two reasons. Saving a domain writes a row and is instant; this runs
 * certbot on the host and can take the better part of a minute, so the two
 * need different affordances and different failure copy. And this section is
 * only meaningful once a domain is saved — it can say so, where a disabled
 * button wedged into the domain form could not explain itself.
 *
 * Nothing here is required. Paco serves over HTTP and works; a certificate is
 * something the operator asks for when they want one. Platforms that terminate
 * TLS upstream (Krova Cloud, Cloudflare's proxy, any load balancer) already
 * have HTTPS and should not use this at all — `paco tls` detects that case and
 * declines, and its explanation is surfaced verbatim below.
 */
export function CertificateSection() {
  const [status, setStatus] = useState<CertificateStatus | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [output, setOutput] = useState<string | null>(null);

  // Same generation-counter pattern as `DomainSection`: a response that lands
  // after unmount, or after a newer call started, can tell it is stale and
  // skip every state update it would otherwise make.
  const requestIdRef = useRef(0);

  const loadStatus = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoadError(false);
    try {
      const next = await getCertificateStatus();
      if (requestIdRef.current !== requestId) {
        return;
      }
      setStatus(next);
    } catch {
      if (requestIdRef.current !== requestId) {
        return;
      }
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    // Saving a domain next door changes what this section should say, and
    // nothing else would tell it. `loadStatus` bumps the generation counter
    // itself, so a re-read triggered here supersedes the mount's own.
    const unsubscribe = onDomainSaved(() => {
      void loadStatus();
    });
    return () => {
      unsubscribe();
      requestIdRef.current += 1;
    };
  }, [loadStatus]);

  async function handleRequest() {
    setRequesting(true);
    setOutput(null);
    try {
      const result = await requestCertificate();
      if (result.success) {
        toast.success("Certificate installed.", {
          description: "nginx now serves this domain over HTTPS.",
        });
        setOutput(result.output || null);
        await loadStatus();
      } else {
        // Deliberately not a toast alone: every failure here is a fact about
        // the host (DNS, port 80, rate limits, TLS terminated upstream) and
        // the operator needs the text in front of them to act on it.
        toast.error("The certificate could not be issued.");
        setOutput(result.error);
      }
    } catch {
      toast.error("The certificate could not be issued.");
      setOutput(
        "The request failed before it reached the host. Check that Paco's service is running.",
      );
    } finally {
      setRequesting(false);
    }
  }

  const noDomain = status?.state === "no-domain";

  return (
    <section className="rounded-lg border border-base-content/10">
      <div className="border-base-content/10 border-b px-5 py-4">
        <h2 className="flex items-center gap-2 font-semibold text-base">
          <Lock aria-hidden="true" className="size-4" />
          Certificate
        </h2>
        <p className="mt-1 text-base-content/60 text-sm">
          Optional. Paco serves over HTTP out of the box — request a certificate
          here if you want it to serve HTTPS itself.
        </p>
      </div>

      <div className="px-5 py-4">
        {loadError ? (
          <div className="alert alert-error alert-soft" role="alert">
            <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
            <span>The certificate status couldn&apos;t be loaded.</span>
            <button
              className="btn btn-sm"
              onClick={() => void loadStatus()}
              type="button"
            >
              Try again
            </button>
          </div>
        ) : (
          <>
            {noDomain ? (
              <div className="alert alert-soft" role="alert">
                <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
                <span>
                  Save a domain above first — a certificate is issued for a
                  hostname, so there is nothing to request yet.
                </span>
              </div>
            ) : null}

            {status?.state === "present" ? (
              <p className="flex items-center gap-2 text-sm">
                <ShieldCheck aria-hidden="true" className="size-4 shrink-0" />
                <span>
                  A certificate for <code>{status.hostname}</code> is installed.
                  Requesting again renews it only if it is close to expiring.
                </span>
              </p>
            ) : null}

            {status?.state === "unknown" ? (
              <p className="text-base-content/70 text-sm">
                Paco can&apos;t tell whether <code>{status.hostname}</code>{" "}
                already has a certificate — the directory certbot stores them in
                is readable only by root. Requesting one is safe either way: an
                existing certificate that isn&apos;t near expiry is left alone.
              </p>
            ) : null}

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                className="btn btn-sm"
                disabled={status === null || requesting || noDomain}
                onClick={() => void handleRequest()}
                type="button"
              >
                {requesting ? (
                  <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                ) : null}
                {requesting ? "Requesting…" : "Request certificate"}
              </button>
              {requesting ? (
                <span className="text-base-content/60 text-sm">
                  This can take up to a minute.
                </span>
              ) : null}
            </div>

            <p className="mt-3 text-base-content/60 text-sm">
              Requires the domain above to already point at this server, and
              port 80 to be reachable from the internet. If something in front
              of this server already terminates TLS — Krova Cloud,
              Cloudflare&apos;s proxy, a load balancer — skip this; HTTPS
              already works and requesting a certificate here would fail.
            </p>

            {output === null ? null : (
              // Deliberately not daisyUI's `mockup-code`, which was the first
              // attempt: it styles `pre` with `white-space: pre` and scrolls
              // long lines sideways. That is right for a code listing and
              // wrong for this, because certbot's errors are sentences long
              // enough that the end — the part saying what to do about it —
              // was the part scrolled out of view. Its `.mockup-code pre`
              // selector also outranks a `whitespace-pre-wrap` utility, so
              // wrapping inside it needs `!`; a plain box needs no override at
              // all.
              //
              // Deliberately not daisyUI's `mockup-code`: it styles its `pre`
              // with `white-space: pre` and scrolls long lines sideways, which
              // is right for a code listing and wrong here — certbot's errors
              // are sentences long enough that the end, the part saying what to
              // do about it, was the part scrolled out of view.
              //
              // `whitespace-pre-wrap` keeps certbot's line breaks, which carry
              // meaning, while still wrapping; `wrap-break-word` stops an
              // unbroken path or URL from pushing the panel wider than the
              // page. Both work on a `pre` only because `globals.css`'s
              // `white-space: pre !important` is now scoped to streamdown's
              // code blocks — as a bare `pre` rule it silently beat every such
              // utility in the app.
              <pre className="mt-4 w-full whitespace-pre-wrap wrap-break-word rounded-md bg-base-200 p-3 font-mono text-base-content/80 text-xs">
                {output}
              </pre>
            )}
          </>
        )}
      </div>
    </section>
  );
}
