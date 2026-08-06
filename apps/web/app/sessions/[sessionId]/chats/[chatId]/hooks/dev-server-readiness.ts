/**
 * Wait until the app is actually answering before calling it started.
 *
 * The launch route deliberately does not wait. It runs `install && dev` with
 * `stdio: "ignore"` and `detached: true`, then answers 200 with a URL as soon
 * as the shell is spawned — usually within a second or two, while `npm install`
 * still has minutes to run.
 *
 * The panel believed that 200. It flipped to "running", mounted an iframe at a
 * port where nothing was listening, and the user got the browser's own
 * connection-refused page. When the install failed outright — a missing
 * package manager, a peer-dependency conflict, no network in the container —
 * the output went to `/dev/null`, so the panel sat on "running" against a dead
 * port forever, with no error anywhere and a "Stop preview" button for a server
 * that never existed.
 *
 * The reassuring line the panel shows while starting ("This takes a moment the
 * first time — the app has to install and build") had the same problem in
 * reverse: it was tied to the POST, so it vanished a second in, right before
 * the multi-minute wait it was written to explain.
 *
 * So: keep polling the status route, which answers from the container and only
 * says `running` once something is genuinely listening on the port. The caller
 * stays in its "starting" state throughout, which is both honest and what makes
 * that reassuring line stay on screen for the whole wait.
 */

/**
 * How long to wait for a first response.
 *
 * A cold `pnpm install` plus a Next.js first compile on a large project is
 * minutes, not seconds, so this is generous on purpose. Giving up early on a
 * project that was going to work is worse than making someone wait: they press
 * Start again, which collides with the install already running.
 */
export const DEV_SERVER_READY_TIMEOUT_MS = 240_000;

/** Slow enough not to hammer the container, fast enough to feel immediate. */
export const DEV_SERVER_POLL_INTERVAL_MS = 1500;

/**
 * What the user reads when the wait runs out.
 *
 * It does not claim the app failed, because we cannot tell the difference from
 * out here between a failed install and a very slow one — and saying "it
 * failed" about an app that is still building is its own dead end. It says what
 * is true, gives the wait a number, and offers the two things that can help.
 */
export const DEV_SERVER_SLOW_START_MESSAGE =
  "Your app hasn't started responding yet. Installing and building can take a few minutes the first time — press Start preview to check again. If it never starts, ask the assistant in the chat to run the app and tell you what it says.";

/** Just enough of `fetch` to be substituted in a test. */
type FetchLike = (input: string) => Promise<Response>;

export type DevServerReadyResult =
  | { ok: true }
  | {
      ok: false;
      message: string;
      /**
       * The app's own last output, when the wait ran out and there was any.
       *
       * Absent when the wait was abandoned rather than exhausted: leaving the
       * chat is not a failure worth explaining, and fetching a log for a tab
       * that has gone is work nobody asked for.
       */
      lastOutput?: string | null;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Whether a status body means "something is listening on the port".
 *
 * Split out because it is the one judgement worth testing on its own, and
 * because "not running yet" and "the probe failed" must not be confused: a
 * status route that 500s is a reason to keep waiting, not a reason to declare
 * the app dead.
 */
export function isDevServerListening(body: unknown): boolean {
  return isRecord(body) && body.running === true;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export async function waitForDevServerReady(params: {
  sessionId: string;
  chatId: string;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Abandoned when the component unmounts or the chat changes. */
  isCancelled?: () => boolean;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<DevServerReadyResult> {
  const doFetch = params.fetchImpl ?? fetch;
  const sleep = params.sleep ?? defaultSleep;
  const now = params.now ?? Date.now;
  const isCancelled = params.isCancelled ?? (() => false);
  const timeoutMs = params.timeoutMs ?? DEV_SERVER_READY_TIMEOUT_MS;
  const intervalMs = params.intervalMs ?? DEV_SERVER_POLL_INTERVAL_MS;

  const startedAt = now();
  const url = `/api/sessions/${params.sessionId}/dev-server?chatId=${encodeURIComponent(
    params.chatId,
  )}`;

  while (now() - startedAt < timeoutMs) {
    if (isCancelled()) {
      return { ok: false, message: DEV_SERVER_SLOW_START_MESSAGE };
    }

    try {
      const response = await doFetch(url);
      const body: unknown = await response.json().catch(() => null);

      if (response.ok && isDevServerListening(body)) {
        return { ok: true };
      }
    } catch {
      // A probe that could not be made says nothing about the app. The tab may
      // have gone offline for a moment; keep waiting until the clock says stop.
    }

    await sleep(intervalMs);
  }

  /*
   * One last request, this time asking for the log.
   *
   * The poll above deliberately does not ask: it runs every 1.5s for up to
   * four minutes, and reading the log costs an extra `docker exec` each time
   * for an answer it never uses. Here the wait has already failed, so one more
   * round trip is worth what it buys — a failed `pnpm install` leaves its
   * reason in that file, and without this the user is told only that the app
   * is "taking a while" while the explanation sits on disk unread.
   */
  return {
    lastOutput: await readLastOutput(doFetch, url),
    message: DEV_SERVER_SLOW_START_MESSAGE,
    ok: false,
  };
}

async function readLastOutput(
  doFetch: FetchLike,
  url: string,
): Promise<string | null> {
  try {
    const response = await doFetch(`${url}&logs=1`);
    const body: unknown = await response.json().catch(() => null);

    if (isRecord(body) && typeof body.lastOutput === "string") {
      const trimmed = body.lastOutput.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
  } catch {
    // The log is a bonus. Failing to read it must not turn a timeout into an
    // error about reading logs.
  }

  return null;
}
