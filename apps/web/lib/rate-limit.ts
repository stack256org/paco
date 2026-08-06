type RateLimitOptions = {
  key: string;
  limit: number;
  windowMs: number;
};

type Window = {
  count: number;
  resetAt: number;
};

/**
 * Fixed-window rate limiting, in process memory.
 *
 * This used to require Redis, and because `REDIS_URL` is optional it degraded
 * to *no limiting at all* on a install that had not configured one — which is
 * every default install. The limits guard genuinely expensive work (creating a
 * sandbox, generating a PR body), so silently having none was the wrong
 * outcome.
 *
 * Paco is a single self-hosted process, so a Map is the whole requirement: no
 * service to run, nothing to fall back to, and no timeout path that has to
 * decide between failing open and failing closed. The tradeoff is that limits
 * are per-process — run several instances behind a load balancer and each gets
 * its own budget. That is a deliberate trade for a single-tenant tool, not an
 * oversight.
 *
 * Held on `globalThis` because a module-level Map does not survive a Turbopack
 * rebuild in development, which would silently reset every window on each edit.
 */
const globalForRateLimit = globalThis as typeof globalThis & {
  __pacoRateLimit?: Map<string, Window>;
};

function windows(): Map<string, Window> {
  globalForRateLimit.__pacoRateLimit ??= new Map<string, Window>();
  return globalForRateLimit.__pacoRateLimit;
}

/**
 * Drop windows that have already expired.
 *
 * Keys embed a user id, so without this the map grows for the life of the
 * process. Swept on write rather than on a timer: there is no work to do when
 * nothing is being rate limited.
 */
function sweep(now: number): void {
  for (const [key, window] of windows()) {
    if (window.resetAt <= now) {
      windows().delete(key);
    }
  }
}

function rateLimitResponse(retryAfterMs: number): Response {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));

  return Response.json(
    { error: "You're going a little fast. Wait a moment, then try again." },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds) },
    },
  );
}

/**
 * Count this request against `key`, and return a 429 response once the window's
 * limit is exceeded. Returns `null` while the caller is within budget, so a
 * route reads as `const limited = await checkRateLimit(...); if (limited) return limited;`.
 */
export function checkRateLimit(options: RateLimitOptions): Response | null {
  const now = Date.now();
  sweep(now);

  const existing = windows().get(options.key);

  if (!existing || existing.resetAt <= now) {
    windows().set(options.key, { count: 1, resetAt: now + options.windowMs });
    return null;
  }

  existing.count += 1;

  if (existing.count <= options.limit) {
    return null;
  }

  return rateLimitResponse(existing.resetAt - now);
}

export function rateLimitKey(parts: (number | string | null | undefined)[]) {
  return parts.map((part) => String(part ?? "unknown")).join(":");
}
