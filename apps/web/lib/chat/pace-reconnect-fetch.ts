type FetchFunction = typeof globalThis.fetch;

/**
 * The smallest gap allowed between two consecutive resume requests.
 *
 * A live stream reconnects rarely — on a dropped connection or a page
 * return — so a second of spacing is invisible in normal use.
 */
export const MIN_RECONNECT_INTERVAL_MS = 1_000;

function isReconnectRequest(input: Parameters<FetchFunction>[0]): boolean {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;

  return new URL(url, "http://localhost").pathname.endsWith("/stream");
}

function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    }

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Rate-limit the resume endpoint to one request per interval.
 *
 * `WorkflowChatTransport` resumes inside `while (!gotFinish)` with no delay
 * between iterations: it re-fetches immediately whenever a response ends
 * without a `finish` chunk. Any server response that is well-formed but
 * carries no chunks therefore becomes a hot loop — one such response was
 * measured at roughly 50 requests a second, sustained, per open tab.
 *
 * The server no longer produces that response, but the loop is in a library
 * we do not control and its only exit is a chunk we cannot guarantee: an
 * interrupted run can leave a recorded stream with no `finish` in it at all.
 * This keeps the worst case at one request a second instead of fifty, so a
 * bug of this shape shows up as a slow poll rather than as an outage.
 */
export function paceReconnectFetch(inner: FetchFunction): FetchFunction {
  let nextAllowedAt = 0;

  const paced = async (
    input: Parameters<FetchFunction>[0],
    init?: Parameters<FetchFunction>[1],
  ): Promise<Response> => {
    if (!isReconnectRequest(input)) {
      return inner(input, init);
    }

    const waitMs = nextAllowedAt - Date.now();
    if (waitMs > 0) {
      await delay(waitMs, init?.signal);
    }

    nextAllowedAt = Date.now() + MIN_RECONNECT_INTERVAL_MS;
    return inner(input, init);
  };

  return Object.assign(paced, { preconnect: inner.preconnect });
}
