import { posix } from "node:path";
import { connectSandbox, type Sandbox, type SandboxState } from "@paco/sandbox";
import {
  requireAuthenticatedUser,
  requireOwnedSessionWithSandboxGuard,
} from "@/app/api/sessions/_lib/session-context";
import { resolveWorkCwd } from "@/lib/agent/workspace-paths";
import { updateSession } from "@/lib/db/sessions";
import { buildHibernatedLifecycleUpdate } from "@/lib/sandbox/lifecycle";
import {
  clearUnavailableSandboxState,
  hasRuntimeSandboxState,
  isSandboxUnavailableError,
} from "@/lib/sandbox/utils";
import {
  BAD_FILE_SELECTION,
  WORKSPACE_ASLEEP,
  WORKSPACE_NOT_STARTED,
  WORKSPACE_UNREACHABLE,
} from "@/lib/error-copy";

/**
 * The git directory is not an ordinary file: a chat's branch, its history, and
 * the worktree wiring all live in it. Renaming or deleting it destroys the
 * chat, and writing into it can do the same more quietly, so the file API
 * refuses to address it at any depth.
 */
const GIT_DIR_SEGMENT = ".git";

/**
 * Normalize a caller-supplied workspace-relative path.
 *
 * Returns `null` for anything that is not a plain relative path inside the
 * workspace: absolute paths, `..` traversal, NUL bytes, and empty input. The
 * caller turns that into a 400 rather than clamping the path, so an attempt to
 * escape is visible instead of silently rewritten.
 */
export function normalizeRequestedFilePath(
  rawPath: string | null,
): string | null {
  if (!rawPath) {
    return null;
  }

  const trimmedPath = rawPath.trim();
  if (!trimmedPath || trimmedPath.includes("\0")) {
    return null;
  }

  const normalizedPath = posix.normalize(trimmedPath.replaceAll("\\", "/"));
  if (
    !normalizedPath ||
    normalizedPath === "." ||
    normalizedPath === ".." ||
    normalizedPath.startsWith("../") ||
    posix.isAbsolute(normalizedPath)
  ) {
    return null;
  }

  return normalizedPath;
}

/**
 * Whether a normalized path addresses the git directory at any depth.
 *
 * The comparison is case-insensitive because the host filesystem may be too:
 * on macOS `.GIT/config` and `.git/config` are the same file, so an exact
 * match would leave the guard open to the difference in spelling.
 */
export function touchesGitDirectory(normalizedPath: string): boolean {
  return normalizedPath
    .split("/")
    .some((segment) => segment.toLowerCase() === GIT_DIR_SEGMENT);
}

/**
 * Turn a normalized relative path into an absolute path inside the workspace.
 *
 * `normalizeRequestedFilePath` already rejects traversal, so this is the second
 * of two gates rather than the first: the result is confirmed to sit under the
 * workspace root before it can reach `writeFile` or a shell command. Returns
 * `null` when it does not.
 */
export function resolveWorkspacePath(
  workspaceRoot: string,
  normalizedPath: string,
): string | null {
  const root = posix.normalize(workspaceRoot).replace(/\/+$/, "");
  const fullPath = posix.normalize(posix.join(root, normalizedPath));

  if (fullPath === root || !fullPath.startsWith(`${root}/`)) {
    return null;
  }

  return fullPath;
}

/**
 * Reject a path that must not be written, moved, or removed.
 *
 * Takes the already-normalized path so a route can run it before it connects
 * to the sandbox. Returns the rejection `Response`, or `null` when the path is
 * usable.
 */
export function validateWritablePath(
  normalizedPath: string | null,
): Response | null {
  if (!normalizedPath) {
    return Response.json({ error: BAD_FILE_SELECTION }, { status: 400 });
  }

  if (touchesGitDirectory(normalizedPath)) {
    return Response.json(
      {
        error:
          "That folder holds this workspace's history and can't be edited here.",
      },
      { status: 400 },
    );
  }

  return null;
}

export function isMissingFileError(message: string): boolean {
  const normalizedMessage = message.toLowerCase();
  return (
    normalizedMessage.includes("enoent") ||
    normalizedMessage.includes("no such file") ||
    normalizedMessage.includes("not found")
  );
}

export type WorkspaceFileAccessResult =
  | {
      ok: true;
      sandbox: Sandbox;
      sandboxState: SandboxState;
      /** Absolute path of the chat's worktree (or the session repository). */
      workspaceRoot: string;
    }
  | {
      ok: false;
      response: Response;
    };

interface RequireWorkspaceFileAccessParams {
  sessionId: string;
  chatId: string | null;
  /**
   * Cheap request validation, run after authentication and before any session
   * lookup or sandbox connection. Return a `Response` to reject; `null` to
   * continue. Keeping it here is what lets a malformed path fail without ever
   * touching the sandbox.
   */
  validateRequest?: () => Response | null;
}

/**
 * Resolve everything a workspace file request needs: the caller is
 * authenticated, the session is theirs, its sandbox is live, and the chat's
 * working directory is known.
 *
 * A sandbox that has gone away is reported as a 409 and the session is marked
 * hibernated, which is the same contract the rest of the sandbox-backed routes
 * use.
 */
export async function requireWorkspaceFileAccess(
  params: RequireWorkspaceFileAccessParams,
): Promise<WorkspaceFileAccessResult> {
  const { sessionId, chatId, validateRequest } = params;

  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return { ok: false, response: authResult.response };
  }

  const validationResponse = validateRequest?.();
  if (validationResponse) {
    return { ok: false, response: validationResponse };
  }

  const sessionContext = await requireOwnedSessionWithSandboxGuard({
    userId: authResult.userId,
    sessionId,
    sandboxGuard: hasRuntimeSandboxState,
    sandboxErrorMessage: WORKSPACE_NOT_STARTED,
  });
  if (!sessionContext.ok) {
    return { ok: false, response: sessionContext.response };
  }

  const sandboxState = sessionContext.sessionRecord.sandboxState;
  if (!sandboxState) {
    return {
      ok: false,
      response: Response.json(
        { error: WORKSPACE_NOT_STARTED },
        { status: 400 },
      ),
    };
  }

  try {
    const sandbox = await connectSandbox(sandboxState);
    return {
      ok: true,
      sandbox,
      sandboxState,
      workspaceRoot: resolveWorkCwd(sandboxState, chatId),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unavailableResponse = await handleSandboxUnavailable({
      sessionId,
      sandboxState,
      message,
    });
    if (unavailableResponse) {
      return { ok: false, response: unavailableResponse };
    }

    console.error("Failed to connect to the workspace sandbox:", error);
    return {
      ok: false,
      response: Response.json(
        { error: WORKSPACE_UNREACHABLE },
        { status: 500 },
      ),
    };
  }
}

/**
 * Mark the session hibernated and answer 409 when the sandbox has gone away.
 *
 * Returns `null` when the failure is something else, so the caller can apply
 * its own error shape.
 */
export async function handleSandboxUnavailable(params: {
  sessionId: string;
  sandboxState: SandboxState | null;
  message: string;
}): Promise<Response | null> {
  const { sessionId, sandboxState, message } = params;
  if (!isSandboxUnavailableError(message)) {
    return null;
  }

  await updateSession(sessionId, {
    sandboxState: clearUnavailableSandboxState(sandboxState, message),
    ...buildHibernatedLifecycleUpdate(),
  });

  return Response.json({ error: WORKSPACE_ASLEEP }, { status: 409 });
}
