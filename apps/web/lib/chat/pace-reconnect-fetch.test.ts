import { describe, expect, test } from "bun:test";
import {
  MIN_RECONNECT_INTERVAL_MS,
  paceReconnectFetch,
} from "./pace-reconnect-fetch";

function countingFetch() {
  const calls: string[] = [];
  const fn = ((input: RequestInfo | URL) => {
    calls.push(String(input));
    return Promise.resolve(new Response(null, { status: 200 }));
  }) as unknown as typeof globalThis.fetch;

  return { calls, fn };
}

describe("paceReconnectFetch", () => {
  test("lets the first resume request through immediately", async () => {
    const { calls, fn } = countingFetch();
    const paced = paceReconnectFetch(fn);

    const startedAt = Date.now();
    await paced("http://localhost/api/chat/c1/stream?startIndex=0");

    expect(calls).toHaveLength(1);
    expect(Date.now() - startedAt).toBeLessThan(MIN_RECONNECT_INTERVAL_MS);
  });

  test("spaces out a back-to-back resume loop", async () => {
    // This is the failure being guarded against: the transport's
    // `while (!gotFinish)` loop re-fetches with no delay of its own.
    const { calls, fn } = countingFetch();
    const paced = paceReconnectFetch(fn);

    await paced("http://localhost/api/chat/c1/stream?startIndex=0");

    const second = paced("http://localhost/api/chat/c1/stream?startIndex=0");
    // The second request must still be waiting, not already sent.
    await Promise.resolve();
    expect(calls).toHaveLength(1);

    await second;
    expect(calls).toHaveLength(2);
  });

  test("does not delay ordinary requests", async () => {
    const { calls, fn } = countingFetch();
    const paced = paceReconnectFetch(fn);

    await paced("http://localhost/api/chat");
    await paced("http://localhost/api/chat");
    await paced("http://localhost/api/sessions?status=active");

    expect(calls).toHaveLength(3);
  });

  test("a paced request abandons its wait when the caller aborts", async () => {
    const { calls, fn } = countingFetch();
    const paced = paceReconnectFetch(fn);
    await paced("http://localhost/api/chat/c1/stream?startIndex=0");

    const controller = new AbortController();
    const pending = paced("http://localhost/api/chat/c1/stream?startIndex=0", {
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  test("accepts Request and URL inputs", async () => {
    const { calls, fn } = countingFetch();
    const paced = paceReconnectFetch(fn);

    await paced(new URL("http://localhost/api/chat/c1/stream?startIndex=0"));
    expect(calls).toHaveLength(1);

    await paced(new Request("http://localhost/api/chat"));
    expect(calls).toHaveLength(2);
  });
});
