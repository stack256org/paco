import { Buffer } from "node:buffer";
import { posix } from "node:path";
import { z } from "zod";
import {
  handleSandboxUnavailable,
  isMissingFileError,
  normalizeRequestedFilePath,
  requireWorkspaceFileAccess,
  resolveWorkspacePath,
  validateWritablePath,
} from "@/lib/workspace-files/request";
import { BAD_FILE_SELECTION, BAD_REQUEST } from "@/lib/error-copy";

export type WorkspaceFileContentResponse = {
  path: string;
  content: string;
  size: number;
};

export type WorkspaceFileSaveResponse = {
  path: string;
  size: number;
};

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

const MAX_FILE_PREVIEW_BYTES = 200_000;
const MAX_FILE_SAVE_BYTES = 2_000_000;

const saveBodySchema = z.object({
  content: z.string(),
});

function invalidPathResponse(): Response {
  return Response.json({ error: BAD_FILE_SELECTION }, { status: 400 });
}

export async function GET(req: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  const requestUrl = new URL(req.url);
  const filePath = normalizeRequestedFilePath(
    requestUrl.searchParams.get("path"),
  );

  const access = await requireWorkspaceFileAccess({
    sessionId,
    chatId: requestUrl.searchParams.get("chatId"),
    validateRequest: () => (filePath ? null : invalidPathResponse()),
  });
  if (!access.ok) {
    return access.response;
  }

  const { sandbox, sandboxState, workspaceRoot } = access;
  // `validateRequest` already rejected a bad path; this repeats the check so
  // the narrowed type is available, and confirms the joined path lands inside
  // the workspace.
  const fullPath = filePath
    ? resolveWorkspacePath(workspaceRoot, filePath)
    : null;
  if (!(filePath && fullPath)) {
    return invalidPathResponse();
  }

  try {
    const stats = await sandbox.stat(fullPath);

    if (!stats.isFile()) {
      return Response.json(
        {
          error: stats.isDirectory()
            ? "Directories cannot be previewed"
            : "Only regular files can be previewed",
        },
        { status: 400 },
      );
    }

    if (stats.size > MAX_FILE_PREVIEW_BYTES) {
      return Response.json(
        { error: "This file is too big to show here." },
        { status: 413 },
      );
    }

    const content = await sandbox.readFile(fullPath, "utf-8");
    if (content.includes("\0")) {
      return Response.json(
        { error: "This file isn't text, so there's nothing to show." },
        { status: 400 },
      );
    }

    const response: WorkspaceFileContentResponse = {
      path: filePath,
      content,
      size: stats.size,
    };

    return Response.json(response, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unavailableResponse = await handleSandboxUnavailable({
      sessionId,
      sandboxState,
      message,
    });
    if (unavailableResponse) {
      return unavailableResponse;
    }

    if (isMissingFileError(message)) {
      return Response.json(
        {
          error:
            "That file isn't there any more. It may have been renamed or deleted.",
        },
        { status: 404 },
      );
    }

    console.error("Failed to load workspace file:", error);
    return Response.json(
      { error: "We couldn't open that file. Reload the page and try again." },
      { status: 500 },
    );
  }
}

/**
 * Save a file, creating it and any missing parent directories.
 *
 * The write goes through `sandbox.writeFile`, which resolves the path against
 * the workspace and refuses anything outside it — the normalization and the
 * workspace-root check here are the two gates in front of that, so a traversal
 * attempt is answered with a 400 rather than an escape error.
 */
export async function PUT(req: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  const requestUrl = new URL(req.url);
  const filePath = normalizeRequestedFilePath(
    requestUrl.searchParams.get("path"),
  );

  const access = await requireWorkspaceFileAccess({
    sessionId,
    chatId: requestUrl.searchParams.get("chatId"),
    validateRequest: () => validateWritablePath(filePath),
  });
  if (!access.ok) {
    return access.response;
  }

  const { sandbox, sandboxState, workspaceRoot } = access;
  const fullPath = filePath
    ? resolveWorkspacePath(workspaceRoot, filePath)
    : null;
  if (!(filePath && fullPath)) {
    return invalidPathResponse();
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return Response.json({ error: BAD_REQUEST }, { status: 400 });
  }

  const parsedBody = saveBodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return Response.json({ error: BAD_REQUEST }, { status: 400 });
  }

  const { content } = parsedBody.data;
  if (content.includes("\0")) {
    return Response.json(
      { error: "This file isn't text, so it can't be edited here." },
      { status: 400 },
    );
  }

  const size = Buffer.byteLength(content, "utf8");
  if (size > MAX_FILE_SAVE_BYTES) {
    return Response.json(
      { error: "This file is too big to save." },
      { status: 413 },
    );
  }

  try {
    // A missing file is the normal case for a new file, so only an existing
    // entry of the wrong kind is an error here.
    try {
      const stats = await sandbox.stat(fullPath);
      if (stats.isDirectory()) {
        return Response.json(
          { error: "There's already a folder with that name." },
          { status: 400 },
        );
      }
      if (!stats.isFile()) {
        return Response.json(
          { error: "Only files can be saved, and this is a folder." },
          { status: 400 },
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isMissingFileError(message)) {
        throw error;
      }
    }

    await sandbox.mkdir(posix.dirname(fullPath), { recursive: true });
    await sandbox.writeFile(fullPath, content, "utf-8");

    const response: WorkspaceFileSaveResponse = {
      path: filePath,
      size,
    };

    return Response.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unavailableResponse = await handleSandboxUnavailable({
      sessionId,
      sandboxState,
      message,
    });
    if (unavailableResponse) {
      return unavailableResponse;
    }

    console.error("Failed to save workspace file:", error);
    return Response.json(
      { error: "We couldn't save that file. Try again." },
      { status: 500 },
    );
  }
}
