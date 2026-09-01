import { z } from "zod";
import { isHttpUrlWithHost } from "@/lib/app-url";

/**
 * Validation for the settings an administrator can change about this
 * installation.
 *
 * Kept out of `instance-settings-actions.ts`: that file has a top-level
 * `"use server"` directive, under which every export must be an async
 * function, so a plain Zod schema would fail to compile there. Living here
 * instead also lets tests exercise the schemas directly, without a database.
 */

const APP_DOMAIN_MESSAGE =
  'Enter the full address, including the scheme — for example https://paco.example.com. A missing scheme is the usual cause: "localhost:3066" parses as a scheme, not a host.';

/**
 * Whether `value` is a domain this form can save.
 *
 * Deliberately the same rule `appUrl()` enforces at boot (`isHttpUrlWithHost`
 * in `lib/app-url.ts`), not Zod's own `z.url()` — that accepts anything
 * `new URL()` parses, which includes `localhost:3066`, `ftp://paco.example`
 * and `javascript:alert(1)`. Saving one of those here used to pass validation
 * and then make every route — including this settings page — throw at boot
 * once an operator restarted, with no way back in short of a database edit.
 */
function isUsableAppDomain(value: string): boolean {
  try {
    return isHttpUrlWithHost(new URL(value));
  } catch {
    return false;
  }
}

export const domainSchema = z.object({
  appDomain: z
    .string()
    .trim()
    .nullable()
    .refine((value) => value === null || isUsableAppDomain(value), {
      message: APP_DOMAIN_MESSAGE,
    }),
  tlsEnabled: z.boolean(),
  previewBaseDomain: z
    .string()
    .trim()
    .regex(
      // A dot-separated run of labels, each 1-63 chars from [a-z0-9-] and
      // never starting or ending with a hyphen. `[a-z0-9.-]+` alone (the
      // previous rule) accepted `..`, a leading/trailing dot, and a bare
      // `-` as a "domain" — each of those flows straight into
      // `previewHostname` (`lib/preview/hostname.ts`) and from there into
      // generated nginx config text, so a malformed value here does not
      // just fail to resolve: it can produce a hostname nobody chose on
      // purpose.
      /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/,
      "Enter a bare domain such as previews.example.com, with no scheme",
    )
    .nullable(),
});

/**
 * The one credential the agent runs on. See the schema comment on
 * `instanceSettings.claudeCredentialKind` for why only one kind is ever
 * stored.
 */
export const claudeCredentialSchema = z.object({
  kind: z.enum(["api_key", "setup_token"]),
  value: z.string().trim().min(1, "Enter the credential's value."),
});

const CLAUDE_BASE_URL_MESSAGE =
  "Enter the full address, including the scheme — for example https://gateway.example.com.";

export const claudeGatewaySchema = z.object({
  baseUrl: z
    .string()
    .trim()
    .nullable()
    .refine((value) => value === null || isUsableAppDomain(value), {
      message: CLAUDE_BASE_URL_MESSAGE,
    }),
  modelDiscovery: z.boolean(),
});
