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
      // `-` as a "domain" — each of those reaches `previewSlugFromHost`
      // (`lib/preview/hostname.ts`) as the suffix every incoming preview
      // host is matched against, so a malformed value here does not just
      // fail to resolve: it can make that suffix check behave in ways
      // nobody chose on purpose.
      /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/,
      "Enter a bare domain such as previews.example.com, with no scheme",
    )
    .nullable(),
});

export const smtpSchema = z.object({
  host: z.string().trim().min(1).nullable(),
  port: z.number().int().min(1).max(65_535).nullable(),
  secure: z.boolean().nullable(),
  user: z.string().trim().nullable(),
  /**
   * `""` and whitespace-only both mean "this field was left blank on
   * submit" — the real password is never sent to the browser (see
   * `getInstanceSettings`), so a form that isn't touching this field has
   * nothing else it could submit for it. Normalise blank to `null` so it
   * lands in `saveSmtpSettings`'s existing "leave the stored password
   * alone" branch, rather than the "store this as the new password" branch
   * a bare empty string would otherwise take.
   *
   * The stored value itself is never trimmed here — leading or trailing
   * spaces can be legitimate password characters. Trimming is used only to
   * decide whether the field counts as blank.
   *
   * If an operator wants to genuinely clear SMTP, they clear `host` — that
   * is the field that decides whether SMTP is configured at all.
   */
  password: z
    .string()
    .nullable()
    .transform((value) => (value && value.trim() !== "" ? value : null)),
  from: z.string().trim().min(1).nullable(),
});

/** The address `sendTestEmail` is asked to send to. */
export const emailAddressSchema = z.string().trim().pipe(z.email());

/**
 * The BYO Poolside provider form.
 *
 * `baseUrl`, not `endpoint`: the value is forwarded to the `pool` process as
 * `POOLSIDE_STANDALONE_BASE_URL`, so it is the base URL of a Poolside
 * deployment and it genuinely takes effect. Blank means "use Poolside's
 * default service", which is why `null` is accepted rather than required.
 */
export const poolsideSchema = z.object({
  baseUrl: z
    .string()
    .nullable()
    .transform((value) => (value && value.trim() !== "" ? value.trim() : null))
    .refine((value) => value === null || z.url().safeParse(value).success, {
      message: "Enter a full URL, including the scheme.",
    }),
  binaryPath: z.string().trim().min(1).nullable(),
  /**
   * Same "blank means leave it alone" rule as `smtpSchema.password`: the
   * real key is never sent to the browser (see `getInstanceSettings`), so a
   * form that isn't touching this field has nothing else it could submit.
   */
  apiKey: z
    .string()
    .nullable()
    .transform((value) => (value && value.trim() !== "" ? value : null)),
});
