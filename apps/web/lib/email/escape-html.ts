/**
 * Escape the five characters that matter inside HTML text and attribute
 * values.
 *
 * Every string an email template interpolates into its `html` field is
 * server-controlled today (an invited-by address already on the account, a
 * URL this codebase built from `appUrl()` and a random token) — but "not
 * exploitable yet" is not the same guarantee as "safe by construction", and
 * an email template is exactly the kind of file that outlives the
 * assumptions it was written under.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
