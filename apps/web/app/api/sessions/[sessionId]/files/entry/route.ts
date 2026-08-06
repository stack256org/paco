import { posix } from "node:path";
import type { Sandbox } from "@paco/sandbox";
import { z } from "zod";
import {
  handleSandboxUnavailable,
  isMissingFileError,
  normalizeRequestedFilePath,
  requireWorkspaceFileAccess,
  resolveWorkspacePath,
  validateWritablePath,
} from "@/lib/workspace-files/request";
import { quoteShellArg } from "@/lib/workspace-files/shell";
import { BAD_FILE_SELECTION, BAD_REQUEST } from "@/lib/error-copy";

export type WorkspaceEntryKind = "file" | "directory";

export type WorkspaceEntryCreateResponse = {
  path: string;
  kind: WorkspaceEntryKind;
};

export type WorkspaceEntryRenameResponse = {
  from: string;
  to: string;
};

export type WorkspaceEntryDeleteResponse = {
  path: string;
  deleted: true;
};

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

const ENTRY_COMMAND_TIMEOUT_MS = 30_000;

const createBodySchema = z.object({
  path: z.string(),
  kind: z.enum(["file", "directory"]),
});

const renameBodySchema = z.object({
  from: z.string(),
  to: z.string(),
});

function invalidPathResponse(): Response {
  return Response.json({ error: BAD_FILE_SELECTION }, { status: 400 });
}

function invalidBodyResponse(shape: string): Response {
  return Response.json(
    { error: `Request body must be ${shape}` },
    { status: 400 },
  );
}

type JsonBodyResult = { ok: true; value: unknown } | { ok: false };

async function readJsonBody(req: Request): Promise<JsonBodyResult> {
  try {
    return { ok: true, value: await req.json() };
  } catch {
    return { ok: false };
  }
}

/**
 * Whether an entry exists, without turning a missing entry into an error.
 */
async function entryExists(
  sandbox: Sandbox,
  fullPath: string,
): Promise<boolean> {
  try {
    await sandbox.stat(fullPath);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isMissingFileError(message)) {
      return false;
    }
    throw error;
  }
}

/**
 * Create a file or a directory, together with any missing parents.
 *
 * Body: `{ path: string, kind: "file" | "directory" }`.
 * Query: `chatId`.
 */
export async function POST(req: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  const requestUrl = new URL(req.url);

  // The path lives in the body, so authentication and ownership are settled
  // before the body is read at all.
  const access = await requireWorkspaceFileAccess({
    sessionId,
    chatId: requestUrl.searchParams.get("chatId"),
  });
  if (!access.ok) {
    return access.response;
  }

  const rawBody = await readJsonBody(req);
  if (!rawBody.ok) {
    return Response.json({ error: BAD_REQUEST }, { status: 400 });
  }

  const parsedBody = createBodySchema.safeParse(rawBody.value);
  if (!parsedBody.success) {
    return invalidBodyResponse('{ path: string, kind: "file" | "directory" }');
  }

  const entryPath = normalizeRequestedFilePath(parsedBody.data.path);
  const rejection = validateWritablePath(entryPath);
  if (rejection) {
    return rejection;
  }

  const { kind } = parsedBody.data;
  const { sandbox, sandboxState, workspaceRoot } = access;
  const fullPath = entryPath
    ? resolveWorkspacePath(workspaceRoot, entryPath)
    : null;
  if (!(entryPath && fullPath)) {
    return invalidPathResponse();
  }

  try {
    if (await entryExists(sandbox, fullPath)) {
      return Response.json(
        { error: "There's already a file or folder with that name." },
        { status: 409 },
      );
    }

    if (kind === "directory") {
      await sandbox.mkdir(fullPath, { recursive: true });
    } else {
      await sandbox.mkdir(posix.dirname(fullPath), { recursive: true });
      await sandbox.writeFile(fullPath, "", "utf-8");
    }

    const response: WorkspaceEntryCreateResponse = { path: entryPath, kind };
    return Response.json(response, { status: 201 });
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

    console.error("Failed to create workspace entry:", error);
    return Response.json(
      { error: "We couldn't create that. Try again." },
      { status: 500 },
    );
  }
}

/**
 * Rename or move an entry.
 *
 * Body: `{ from: string, to: string }`.
 * Query: `chatId`.
 *
 * There is no sandbox primitive for this, so it runs `mv` — with both paths
 * shell-quoted, and only after both have been confirmed to resolve inside the
 * chat's workspace.
 */
export async function PATCH(req: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  const requestUrl = new URL(req.url);

  const access = await requireWorkspaceFileAccess({
    sessionId,
    chatId: requestUrl.searchParams.get("chatId"),
  });
  if (!access.ok) {
    return access.response;
  }

  const rawBody = await readJsonBody(req);
  if (!rawBody.ok) {
    return Response.json({ error: BAD_REQUEST }, { status: 400 });
  }

  const parsedBody = renameBodySchema.safeParse(rawBody.value);
  if (!parsedBody.success) {
    return invalidBodyResponse("{ from: string, to: string }");
  }

  const fromPath = normalizeRequestedFilePath(parsedBody.data.from);
  const toPath = normalizeRequestedFilePath(parsedBody.data.to);
  const rejection =
    validateWritablePath(fromPath) ?? validateWritablePath(toPath);
  if (rejection) {
    return rejection;
  }

  const { sandbox, sandboxState, workspaceRoot } = access;
  const fullFromPath = fromPath
    ? resolveWorkspacePath(workspaceRoot, fromPath)
    : null;
  const fullToPath = toPath
    ? resolveWorkspacePath(workspaceRoot, toPath)
    : null;
  if (!(fromPath && toPath && fullFromPath && fullToPath)) {
    return invalidPathResponse();
  }

  try {
    if (!(await entryExists(sandbox, fullFromPath))) {
      return Response.json(
        {
          error:
            "That file isn't there any more. It may have been renamed or deleted.",
        },
        { status: 404 },
      );
    }

    if (await entryExists(sandbox, fullToPath)) {
      return Response.json(
        {
          error:
            "There's already a file or folder with that name in the new location.",
        },
        { status: 409 },
      );
    }

    await sandbox.mkdir(posix.dirname(fullToPath), { recursive: true });

    const command = `mv -- ${quoteShellArg(fullFromPath)} ${quoteShellArg(
      fullToPath,
    )}`;
    const result = await sandbox.exec(
      command,
      workspaceRoot,
      ENTRY_COMMAND_TIMEOUT_MS,
    );

    if (!result.success) {
      const unavailableResponse = await handleSandboxUnavailable({
        sessionId,
        sandboxState,
        message: result.stderr ?? "",
      });
      if (unavailableResponse) {
        return unavailableResponse;
      }

      console.error("Failed to move workspace entry:", result.stderr);
      return Response.json(
        { error: "We couldn't move that. Try again." },
        { status: 500 },
      );
    }

    const response: WorkspaceEntryRenameResponse = {
      from: fromPath,
      to: toPath,
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

    console.error("Failed to move workspace entry:", error);
    return Response.json(
      { error: "We couldn't move that. Try again." },
      { status: 500 },
    );
  }
}

/**
 * Delete an entry; directories go recursively.
 *
 * Query: `path`, `chatId`.
 */
export async function DELETE(req: Request, context: RouteContext) {
  const { sessionId } = await context.params;
  const requestUrl = new URL(req.url);
  const entryPath = normalizeRequestedFilePath(
    requestUrl.searchParams.get("path"),
  );

  const access = await requireWorkspaceFileAccess({
    sessionId,
    chatId: requestUrl.searchParams.get("chatId"),
    validateRequest: () => validateWritablePath(entryPath),
  });
  if (!access.ok) {
    return access.response;
  }

  const { sandbox, sandboxState, workspaceRoot } = access;
  const fullPath = entryPath
    ? resolveWorkspacePath(workspaceRoot, entryPath)
    : null;
  if (!(entryPath && fullPath)) {
    return invalidPathResponse();
  }

  try {
    let isDirectory = false;
    try {
      const stats = await sandbox.stat(fullPath);
      isDirectory = stats.isDirectory();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isMissingFileError(message)) {
        return Response.json(
          {
            error:
              "That file isn't there any more. It may have been renamed or deleted.",
          },
          { status: 404 },
        );
      }
      throw error;
    }

    const command = `rm ${isDirectory ? "-rf" : "-f"} -- ${quoteShellArg(fullPath)}`;
    const result = await sandbox.exec(
      command,
      workspaceRoot,
      ENTRY_COMMAND_TIMEOUT_MS,
    );

    if (!result.success) {
      const unavailableResponse = await handleSandboxUnavailable({
        sessionId,
        sandboxState,
        message: result.stderr ?? "",
      });
      if (unavailableResponse) {
        return unavailableResponse;
      }

      console.error("Failed to delete workspace entry:", result.stderr);
      return Response.json(
        { error: "We couldn't delete that. Try again." },
        { status: 500 },
      );
    }

    const response: WorkspaceEntryDeleteResponse = {
      path: entryPath,
      deleted: true,
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

    console.error("Failed to delete workspace entry:", error);
    return Response.json(
      { error: "We couldn't delete that. Try again." },
      { status: 500 },
    );
  }
}
