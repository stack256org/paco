/**
 * Deciding that a dev server which *was* running has died.
 *
 * Starting is handled by dev-server-readiness.ts, which polls until the port
 * answers and then stops. Nothing watched the app after that, so a crash a
 * minute later — a syntax error the agent just wrote, an out-of-memory kill,
 * `vite` exiting — left the panel claiming "running" over a dead port. The user
 * saw a blank iframe, no message anywhere, and the only way out was guessing
 * that Stop then Start might help.
 *
 * The judgement itself lives here, apart from React, because it is the part
 * that is easy to get wrong and easy to test. Two rules matter:
 *
 * 1. One silent probe is not a crash. A dev server restarts on its own — a
 *    changed config file, a watcher bouncing the process — and the port is gone
 *    for a second or two while it comes back. Declaring a crash on the first
 *    miss would tear the preview down during an ordinary hot reload.
 *
 * 2. "The probe failed" is not "the app is down". A 500 from Paco's own status
 *    route, a dropped request, a laptop that slept: none of those are evidence
 *    about a process inside the container. They neither count towards a crash
 *    nor clear the evidence already gathered.
 */

/**
 * How often to ask whether the app is still answering.
 *
 * Each probe costs two `docker exec` calls in the container — one to read the
 * recorded target, one to read /proc/net/tcp — so this is not free, and it runs
 * for as long as a preview is open. Five seconds is the point where the cost is
 * still a rounding error next to what the agent itself is doing in the same
 * container, and the user is not left staring at a broken iframe wondering
 * whether Paco has noticed. Combined with the threshold below it means a real
 * crash is on screen within about fifteen seconds.
 */
export const DEV_SERVER_LIVENESS_POLL_INTERVAL_MS = 5000;

/**
 * How many consecutive silent probes make a crash.
 *
 * Three, so a restart has ~15s to bring the port back before Paco calls it
 * dead. A Vite restart is about a second and a Next.js restart a few, so this
 * clears both with room to spare, while still being far short of the "I have
 * been staring at a blank page" threshold.
 */
export const DEV_SERVER_LIVENESS_MISS_THRESHOLD = 3;

/** Lines of captured output worth putting in front of the user. */
const DISPLAYED_OUTPUT_LINES = 6;
/** Characters of captured output worth putting in front of the user. */
const DISPLAYED_OUTPUT_CHARS = 500;

/**
 * One reading of "is the app answering?".
 *
 * `unknown` is deliberately a case of its own rather than a silent probe: the
 * whole point of the tolerance logic is that not knowing and knowing it is down
 * are different facts.
 */
export type DevServerProbe =
  | { kind: "listening" }
  | { kind: "silent"; lastOutput: string | null }
  | { kind: "unknown" };

export type DevServerLivenessState = {
  /** Reset by any probe that finds the port answering. */
  consecutiveSilentProbes: number;
  /** The most recent output we managed to capture, kept across probes. */
  lastOutput: string | null;
};

export const INITIAL_DEV_SERVER_LIVENESS_STATE: DevServerLivenessState = {
  consecutiveSilentProbes: 0,
  lastOutput: null,
};

export type DevServerLivenessStep = {
  state: DevServerLivenessState;
  /** True on the probe that crosses the threshold, and on every one after. */
  crashed: boolean;
};

export type DevServerCrashReport = {
  /** One line, short enough for a toast. */
  headline: string;
  /** The explanation, in prose. Never contains the app's own output. */
  message: string;
  /**
   * The last lines the app printed, if any were captured.
   *
   * Kept apart from `message` rather than appended to it. Program output is
   * not prose: it wants a monospace block that can scroll sideways, and
   * concatenating the two forced the panel to render a stack trace as a
   * wrapped paragraph.
   */
  lastOutput: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Turn a status-route answer into a probe reading.
 *
 * Only an explicit `running: false` counts as silence. A body that does not say
 * either way, or a response that was not ok, is `unknown` — including the 409
 * the route returns for a sleeping workspace, which says something about the
 * sandbox rather than about the app.
 */
export function classifyDevServerProbe(params: {
  ok: boolean;
  body: unknown;
}): DevServerProbe {
  if (!(params.ok && isRecord(params.body))) {
    return { kind: "unknown" };
  }

  if (params.body.running === true) {
    return { kind: "listening" };
  }

  if (params.body.running === false) {
    return {
      kind: "silent",
      lastOutput:
        typeof params.body.lastOutput === "string"
          ? params.body.lastOutput
          : null,
    };
  }

  return { kind: "unknown" };
}

export function reduceDevServerLiveness(
  state: DevServerLivenessState,
  probe: DevServerProbe,
  threshold: number = DEV_SERVER_LIVENESS_MISS_THRESHOLD,
): DevServerLivenessStep {
  if (probe.kind === "listening") {
    return { state: INITIAL_DEV_SERVER_LIVENESS_STATE, crashed: false };
  }

  if (probe.kind === "unknown") {
    // Says nothing either way: keep the evidence, add none.
    return {
      state,
      crashed: state.consecutiveSilentProbes >= threshold,
    };
  }

  const consecutiveSilentProbes = state.consecutiveSilentProbes + 1;

  return {
    state: {
      consecutiveSilentProbes,
      lastOutput: probe.lastOutput ?? state.lastOutput,
    },
    crashed: consecutiveSilentProbes >= threshold,
  };
}

/**
 * Trim captured output down to something a person will actually read.
 *
 * The last lines are the ones that matter — a stack trace ends with the reason
 * — so both caps keep the end and drop the beginning.
 */
export function summarizeDevServerOutput(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") {
    return null;
  }

  const lines = raw
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }

  const summary = lines.slice(-DISPLAYED_OUTPUT_LINES).join("\n");

  return summary.length > DISPLAYED_OUTPUT_CHARS
    ? `…${summary.slice(-DISPLAYED_OUTPUT_CHARS)}`
    : summary;
}

/**
 * What the user reads when their app dies.
 *
 * Written for someone who has never opened a terminal: no "process", no
 * "SIGKILL", no exit codes. It says what happened, admits the likely cause
 * without asserting one we cannot see, and names the two things that help —
 * the button in the toolbar above, and the assistant already in the chat.
 *
 * The captured output goes underneath, labelled, rather than being folded into
 * the sentence: it is the app's words, not Paco's, and it is often a stack
 * trace.
 *
 * No port number anywhere. The panel knows one, but "nothing is listening on
 * 5173" is a sentence for someone who already knows what a port is, and that is
 * exactly the person this message is not for.
 */
export function describeDevServerCrash(params: {
  packagePath: string;
  lastOutput?: string | null;
}): DevServerCrashReport {
  const what =
    params.packagePath === "root"
      ? "Your app"
      : `Your app (${params.packagePath})`;
  const headline = `${what} stopped running`;

  const explanation = [
    `${headline}. It was working a moment ago and has now shut down on its own — usually because of an error in the code it was just given.`,
    "Press Start preview to run it again. If it stops again, ask the assistant in the chat to run the app and tell you what went wrong.",
  ].join(" ");

  return {
    headline,
    lastOutput: summarizeDevServerOutput(params.lastOutput) || null,
    message: explanation,
  };
}

/** Just enough of `fetch` to be substituted in a test. */
type FetchLike = (input: string) => Promise<Response>;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Ask, forever, whether the app is still up — and resolve when it is not.
 *
 * Written as a loop over injected time and injected `fetch`, like
 * `waitForDevServerReady`, so the whole watch can be driven instantly in a test
 * with no DOM and no real timers. Everything a browser knows — how to sleep,
 * whether the tab is on screen, whether the component is still mounted — is
 * passed in by the hook that calls this.
 *
 * Resolves with a crash report, or with null when the caller cancels. It never
 * resolves for any other reason: there is no "give up" here, because an app
 * that keeps answering should be watched for as long as it is on screen.
 *
 * `?logs=1` on the request is what makes the status route read the dev server's
 * captured output. It only does that when the app is *not* answering, so a
 * healthy poll costs exactly what it did before.
 */
export async function watchDevServerLiveness(params: {
  sessionId: string;
  chatId: string;
  packagePath: string;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** True once the component is gone, the chat changed, or Stop was pressed. */
  isCancelled?: () => boolean;
  /** False for a backgrounded tab, whose probe nobody would read. */
  isVisible?: () => boolean;
  intervalMs?: number;
  threshold?: number;
}): Promise<DevServerCrashReport | null> {
  const doFetch = params.fetchImpl ?? fetch;
  const sleep = params.sleep ?? defaultSleep;
  const isCancelled = params.isCancelled ?? (() => false);
  const isVisible = params.isVisible ?? (() => true);
  const intervalMs = params.intervalMs ?? DEV_SERVER_LIVENESS_POLL_INTERVAL_MS;
  const threshold = params.threshold ?? DEV_SERVER_LIVENESS_MISS_THRESHOLD;

  const url = `/api/sessions/${params.sessionId}/dev-server?chatId=${encodeURIComponent(
    params.chatId,
  )}&logs=1`;

  let state = INITIAL_DEV_SERVER_LIVENESS_STATE;

  while (!isCancelled()) {
    await sleep(intervalMs);

    if (isCancelled()) {
      return null;
    }

    // Nobody is looking. Skip the request, keep the loop, so returning to the
    // tab gets an answer rather than a fresh five-second wait.
    if (!isVisible()) {
      continue;
    }

    let probe: DevServerProbe;
    try {
      const response = await doFetch(url);
      const body: unknown = await response.json().catch(() => null);
      probe = classifyDevServerProbe({ ok: response.ok, body });
    } catch {
      probe = { kind: "unknown" };
    }

    if (isCancelled()) {
      return null;
    }

    const step = reduceDevServerLiveness(state, probe, threshold);
    state = step.state;

    if (step.crashed) {
      return describeDevServerCrash({
        packagePath: params.packagePath,
        lastOutput: state.lastOutput,
      });
    }
  }

  return null;
}
