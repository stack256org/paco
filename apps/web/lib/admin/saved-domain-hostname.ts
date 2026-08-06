/**
 * The bare hostname from the origin saved in Settings.
 *
 * Its own module, and free of `"use server"`, so it can be tested directly:
 * `tls-actions.ts` is a server-action file whose every export must be an async
 * function, which makes a pure helper living there both untestable in
 * isolation and awkward to export.
 *
 * The column stores a full origin (`https://paco.example.com`), while certbot
 * and `/etc/letsencrypt/live/<name>` both want a hostname — so the scheme, any
 * port, and any path all have to come off. Returns `null` rather than throwing
 * for anything unusable, because both callers treat "no usable hostname" and
 * "no domain saved" the same way: there is nothing to request a certificate
 * for.
 */
export function hostnameFromSavedDomain(
  appDomain: string | null,
): string | null {
  if (appDomain === null || appDomain.trim() === "") {
    return null;
  }

  try {
    // `URL.hostname` drops the port and path for free, and lowercases the
    // host — which is what a certificate name should be anyway.
    return new URL(appDomain.trim()).hostname || null;
  } catch {
    // A value that reached the column by hand rather than through the
    // Settings form need not be a URL at all.
    return null;
  }
}
