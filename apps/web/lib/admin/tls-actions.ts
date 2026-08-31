"use server";

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { runHostCommand } from "@/lib/reaping/run-host-command";
import { readInstanceSettings } from "@/lib/settings/instance-settings";
import { hostnameFromSavedDomain } from "./saved-domain-hostname";

/**
 * Obtaining a TLS certificate for this instance's own domain, from Settings.
 *
 * Kept out of `instance-settings-actions.ts` on purpose: that module only ever
 * reads and writes rows, and this one runs a privileged command on the host.
 * They fail in different ways and are worth reading separately.
 *
 * The app cannot run certbot itself — it runs as the unprivileged `paco` user.
 * It invokes `/usr/lib/paco/paco-tls-hook` through a no-argument sudoers rule,
 * and the hook resolves the domain from the database itself. That means this
 * action cannot request a certificate for an arbitrary hostname even if the
 * process were compromised; see `packaging/paco-tls-hook`'s header for why the
 * grant is shaped that way.
 */

const TLS_HOOK = "/usr/lib/paco/paco-tls-hook";

/**
 * certbot has to answer an HTTP-01 challenge from Let's Encrypt, which means a
 * round trip to a public service plus an nginx reload. 20s (the shared
 * default) is comfortably too short and would report a false failure on a
 * request that was actually still working.
 */
const CERTBOT_TIMEOUT_MS = 180_000;

/** Where certbot puts a certificate it issued for `hostname`. */
function letsEncryptLiveCert(hostname: string): string {
  return `/etc/letsencrypt/live/${hostname}/fullchain.pem`;
}

export type CertificateStatus =
  | { state: "no-domain" }
  | { state: "present"; hostname: string }
  /**
   * Distinct from "absent" on purpose. `/etc/letsencrypt` is root-owned and
   * usually `0700`, so the `paco` user often cannot see a certificate that is
   * really there. Reporting "absent" from an unreadable directory would tell
   * an operator to fix something that is already fine, so an unreadable path
   * says so instead of guessing.
   */
  | { state: "unknown"; hostname: string };

export async function getCertificateStatus(): Promise<CertificateStatus> {
  const settings = await readInstanceSettings();
  const hostname = hostnameFromSavedDomain(settings.appDomain);
  if (hostname === null) {
    return { state: "no-domain" };
  }

  try {
    await access(letsEncryptLiveCert(hostname), constants.R_OK);
    return { state: "present", hostname };
  } catch {
    return { state: "unknown", hostname };
  }
}

export type RequestCertificateResult =
  | { success: true; output: string }
  | { success: false; error: string; output?: string };

/**
 * Ask the host to obtain and install a certificate for the saved domain.
 *
 * Safe to run again: `paco tls` does not pass `--force-renewal`, so an
 * existing unexpired certificate is left alone rather than reissued.
 *
 * The hook's own output is returned rather than summarised. Every way this
 * fails is a fact about the host that the operator has to act on — DNS not
 * pointing here yet, port 80 unreachable, Let's Encrypt rate-limiting the
 * domain, or a platform terminating TLS upstream so the challenge never
 * arrives. A generic "couldn't get a certificate" would hide all of them.
 */
export async function requestCertificate(): Promise<RequestCertificateResult> {
  const result = await runHostCommand(
    "sudo",
    ["-n", TLS_HOOK],
    CERTBOT_TIMEOUT_MS,
  );

  const output = `${result.stdout}${result.stderr}`.trim();

  if (result.ok) {
    return { success: true, output };
  }

  // `sudo -n` refuses rather than prompting when no rule matches, and its
  // message ("a password is required") reads like a misconfigured password
  // rather than a missing sudoers rule — which is the actual cause, and one
  // an upgrade from a version before the rule existed produces.
  if (/password is required|not allowed to execute/i.test(output)) {
    return {
      success: false,
      error:
        "Paco is not allowed to run the certificate hook on this host. This usually means the package was installed before that permission existed — run `sudo apt install --reinstall paco` to reinstall the sudoers rule.",
      output,
    };
  }

  if (result.exitCode === null) {
    return {
      success: false,
      error:
        "The certificate request did not finish in time. certbot may still be running — check `paco logs` and reload this page before trying again.",
      output,
    };
  }

  return {
    success: false,
    error: output || "The certificate request failed without any output.",
    output,
  };
}
