/**
 * Ask the server to stop this chat's dev server, and believe its answer.
 *
 * The DELETE route answers 200 with `{ stopped: false }` when the process is
 * still listening after SIGKILL — it deliberately reports the truth rather than
 * a comforting status code. The caller used to check only `response.ok` and go
 * straight to "idle", so a dev server that survived the kill disappeared from
 * the UI while it was still holding the port, and the next Start collided with
 * it.
 */

export type DevServerStopResult = { ok: true } | { ok: false; message: string };

const STILL_RUNNING_MESSAGE =
  "The dev server is still running. Something is holding the port; try again.";

const FAILED_MESSAGE = "Failed to stop dev server";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Turn a DELETE response body into a verdict.
 *
 * `stopped` missing is treated as success: an older server, or an error body
 * that already carried its own message, should not be reported as "still
 * running" when nothing said it was.
 */
export function readDevServerStopBody(body: unknown): DevServerStopResult {
  if (isRecord(body) && body.stopped === false) {
    return { ok: false, message: STILL_RUNNING_MESSAGE };
  }

  return { ok: true };
}

function readErrorMessage(body: unknown): string {
  if (isRecord(body) && typeof body.error === "string") {
    return body.error;
  }

  return FAILED_MESSAGE;
}

/** Just enough of `fetch` to be substituted in a test. */
type FetchLike = (
  input: string,
  init?: { method?: string },
) => Promise<Response>;

export async function requestDevServerStop(params: {
  sessionId: string;
  chatId: string;
  fetchImpl?: FetchLike;
}): Promise<DevServerStopResult> {
  const { sessionId, chatId } = params;
  const doFetch = params.fetchImpl ?? fetch;

  const response = await doFetch(
    `/api/sessions/${sessionId}/dev-server?chatId=${encodeURIComponent(chatId)}`,
    { method: "DELETE" },
  );
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    return { ok: false, message: readErrorMessage(body) };
  }

  return readDevServerStopBody(body);
}
