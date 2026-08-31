/**
 * Whether this installation is configured well enough to run.
 *
 * Paco is self-hosted, so the person who mis-set a variable is the person
 * staring at the screen — and until now the screen lied to them. `APP_SECRET`
 * is read at module scope somewhere in the boot path, so a missing one threw
 * while Next was still evaluating modules. That is before any error boundary
 * exists: `error.tsx` never rendered, and `global-error.tsx` did, saying
 * "Paco couldn't start… check that the server is running". The server was
 * running. The message sent people to look at the one thing that was fine.
 *
 * `APP_URL` no longer has that shape: `lib/app-url.ts` falls back to
 * localhost when it is unset, so a missing value is valid configuration, not
 * a crash to pre-empt. It is checked here anyway, because a value that *was*
 * set and does not parse still deserves the same banner `APP_SECRET` gets
 * rather than a `new URL()` throw somewhere downstream with no context.
 *
 * This module is deliberately pure and dependency-free otherwise: it takes an
 * environment-shaped record and returns problems. Nothing here touches the
 * database, the filesystem or `process`, so it can be called from the root
 * layout — the earliest place that can still render HTML — and tested without
 * a running app.
 */

import { isHttpUrlWithHost } from "@/lib/app-url";

export type ConfigProblem = {
  /** The variable at fault, shown verbatim so it can be searched for. */
  variable: string;
  /** What is wrong, in one sentence. */
  problem: string;
  /** What to do about it, concretely enough to act on without docs. */
  fix: string;
};

/**
 * The shortest `APP_SECRET` worth accepting.
 *
 * It derives the key that encrypts the stored GitHub token — the only thing
 * it protects, now that there are no sessions to sign. 32 characters is the
 * point at which a random value has enough entropy that
 * guessing it is not the easiest attack; below that the encryption is theatre.
 * This was previously a warning that nothing acted on, and `secret-box.ts`
 * had no length check at all — it would happily derive a key from "hunter2".
 */
const MIN_APP_SECRET_LENGTH = 32;

const APP_URL_HELP =
  "Optional. Set it to the origin you open Paco on, scheme and port included — for example http://localhost:3066 — or leave it unset and Paco serves on http://localhost:3000. See apps/web/.env.example.";

function checkAppUrl(raw: string | undefined): ConfigProblem | null {
  const value = raw?.trim();

  // Absent is not a problem: `appUrl()` falls back to localhost, which is the
  // normal state of a fresh install that has no domain configured yet. Only a
  // value that was actually set and is unusable is worth a banner — a missing
  // one used to be treated the same as a broken one, so every fresh install
  // opened on a config-problem screen demanding a variable it did not need.
  if (!value) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {
      fix: APP_URL_HELP,
      problem: `"${value}" is not a URL.`,
      variable: "APP_URL",
    };
  }

  /*
   * `new URL("localhost:3066")` succeeds — it parses as the scheme
   * "localhost:" with the path "3066" and an empty host. It is the single most
   * common way to get this wrong, and it looks right in a `.env` file, so it
   * gets its own sentence rather than a generic "invalid URL".
   */
  if (!isHttpUrlWithHost(url)) {
    return {
      fix: APP_URL_HELP,
      problem: `"${value}" has no scheme, so it is not a usable address. A value like "localhost:3066" reads as a scheme, not a host.`,
      variable: "APP_URL",
    };
  }

  return null;
}

function checkAppSecret(raw: string | undefined): ConfigProblem | null {
  const value = raw?.trim();

  if (!value) {
    return {
      fix: "Generate one with `openssl rand -base64 48` and set it in the environment. Keep it: changing it later permanently orphans any GitHub token already stored under the old value.",
      problem:
        "This derives the key that encrypts the stored GitHub token. Paco refuses to start without it rather than deriving that key from nothing.",
      variable: "APP_SECRET",
    };
  }

  if (value.length < MIN_APP_SECRET_LENGTH) {
    return {
      fix: "Replace it with a longer random value — `openssl rand -base64 48`. Changing it permanently orphans any GitHub token already stored under the old value, so do it before connecting one.",
      problem: `It is ${value.length} characters. Anything under ${MIN_APP_SECRET_LENGTH} is short enough to guess, which would expose the stored GitHub token.`,
      variable: "APP_SECRET",
    };
  }

  return null;
}

/**
 * Every configuration problem, so one screen can name all of them.
 *
 * Reporting them one at a time would mean fixing a variable, restarting, and
 * being told about the next one — which is the shape of every bad setup
 * experience.
 */
export function findConfigProblems(
  env: Record<string, string | undefined>,
): ConfigProblem[] {
  return [checkAppUrl(env.APP_URL), checkAppSecret(env.APP_SECRET)].filter(
    (problem): problem is ConfigProblem => problem !== null,
  );
}
