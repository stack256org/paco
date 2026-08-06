import type { WorkspaceFileSaveResponse } from "@/app/api/sessions/[sessionId]/files/content/route";
import type {
  WorkspaceEntryCreateResponse,
  WorkspaceEntryDeleteResponse,
  WorkspaceEntryKind,
  WorkspaceEntryRenameResponse,
} from "@/app/api/sessions/[sessionId]/files/entry/route";

/**
 * The write half of the file manager.
 *
 * SWR covers reads; these are one-shot commands, so they return a result
 * object instead of throwing. Every failure comes back as a sentence that can
 * be shown to someone who has never seen an HTTP status: the routes already
 * write their errors that way, so their wording is preferred and the fallbacks
 * here only cover a response that carried no message at all.
 */

export type WriteResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string };

const UNREACHABLE =
  "We couldn't reach your workspace. Check your connection, then try again.";

const UNEXPLAINED = "Something went wrong. Try again.";

function errorMessageFrom(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return null;
  }
  const { error } = body as { error: unknown };
  return typeof error === "string" && error.trim() ? error.trim() : null;
}

async function send<T>(
  url: string,
  init: RequestInit,
): Promise<WriteResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    // A thrown fetch is the network, not the workspace, so it gets its own
    // wording — "try again" is genuinely the right advice here.
    return { ok: false, message: UNREACHABLE };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // An empty or non-JSON body is covered by the fallback copy below.
  }

  if (!response.ok) {
    return { ok: false, message: errorMessageFrom(body) ?? UNEXPLAINED };
  }

  return { ok: true, data: body as T };
}

const JSON_HEADERS = { "Content-Type": "application/json" };

function contentUrl(sessionId: string, chatId: string, path: string): string {
  const params = new URLSearchParams({ path, chatId });
  return `/api/sessions/${sessionId}/files/content?${params.toString()}`;
}

function entryUrl(sessionId: string, chatId: string, path?: string): string {
  const params = new URLSearchParams(
    path === undefined ? { chatId } : { path, chatId },
  );
  return `/api/sessions/${sessionId}/files/entry?${params.toString()}`;
}

export type FileApiTarget = { sessionId: string; chatId: string };

export function saveFile(
  { sessionId, chatId }: FileApiTarget,
  path: string,
  content: string,
): Promise<WriteResult<WorkspaceFileSaveResponse>> {
  return send(contentUrl(sessionId, chatId, path), {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ content }),
  });
}

export function createEntry(
  { sessionId, chatId }: FileApiTarget,
  path: string,
  kind: WorkspaceEntryKind,
): Promise<WriteResult<WorkspaceEntryCreateResponse>> {
  return send(entryUrl(sessionId, chatId), {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ path, kind }),
  });
}

export function renameEntry(
  { sessionId, chatId }: FileApiTarget,
  from: string,
  to: string,
): Promise<WriteResult<WorkspaceEntryRenameResponse>> {
  return send(entryUrl(sessionId, chatId), {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ from, to }),
  });
}

export function deleteEntry(
  { sessionId, chatId }: FileApiTarget,
  path: string,
): Promise<WriteResult<WorkspaceEntryDeleteResponse>> {
  return send(entryUrl(sessionId, chatId, path), { method: "DELETE" });
}
