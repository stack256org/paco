/**
 * Bounds how long one health metric may take before the page gives up on
 * it.
 *
 * `getInstanceHealth` used to await every metric with no bound at all: no
 * `statement_timeout` on the pool, no `AbortSignal.timeout`. A wedged
 * Postgres connection left the whole action pending forever — skeleton on
 * screen, "Check again" disabled, no error ever surfacing. This makes a
 * stuck metric resolve to a rejection once `timeoutMs` has passed, so
 * `Promise.allSettled` in the caller turns it into the same honest
 * `"unavailable"` it already produces for any other failure, rather than a
 * request that never finishes.
 *
 * This does not cancel the underlying query — there is no cheap way to
 * abort a `postgres.js` query or a running `du` mid-flight from here — it
 * only stops the caller from waiting on it. The original promise keeps
 * running to completion (or failure) in the background.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  reason: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(reason));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}
