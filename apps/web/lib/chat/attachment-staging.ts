import "server-only";

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxState } from "@paco/sandbox";
import { hostWorkspaceFor } from "@/lib/agent/workspace-paths";
import {
  type AttachmentPlanEntry,
  sanitizeAttachmentFilename,
  type StagedAttachment,
} from "./attachment-prompt";

/**
 * Writing a turn's oversized attachments somewhere the agent can read them.
 *
 * The agent already has `Read` and `Grep`, and they are strictly better than
 * a prompt for a five-megabyte log: it reads the parts it needs, when it
 * needs them, instead of paying for the whole thing on every turn. So an
 * attachment past the inline budget becomes a file, and the prompt names its
 * path.
 *
 * Node-only, and imported dynamically from inside the chat workflow's
 * `"use step"` — the workflow body itself is replayed in a sandboxed VM with
 * no Node modules, the same reason `run-step`'s memory/skills resolution is
 * deferred the same way.
 */

/**
 * Attachments live BESIDE the repository, never inside it.
 *
 * The chat's worktree is a git repository whose contents the operator stages
 * and commits with `git add` (the Source Control panel,
 * `lib/git/source-control-actions.ts`). A staging directory inside it would land the
 * user's pasted log in their history and their diff. A sibling of the
 * repository under the session's own workspace is invisible to every `git`
 * command run in the worktree, needs no `.gitignore` entry in the user's
 * tree and no edit to their `.git/info/exclude`, and is still an ordinary
 * absolute path the agent can read — `Read` is unconditionally allowed by
 * the approval policy, so naming a path outside the worktree costs the user
 * no prompt.
 */
const ATTACHMENT_DIR_NAME = ".paco-attachments";

export type StageAttachmentsParams = {
  sandboxState: SandboxState;
  chatId: string;
  /** The `chatMessages` row these attachments arrived on. */
  userMessageId: string;
  plan: readonly AttachmentPlanEntry[];
};

/**
 * Write every `stage` entry in `plan` and return where each one landed,
 * keyed by its index in `plan`.
 *
 * Never throws. An attachment that could not be written is simply absent
 * from the result, and `renderAttachmentSection` degrades that one to an
 * excerpt plus a statement that the rest is missing — a turn must not fail
 * because a log could not be saved, and it must not silently pretend the log
 * arrived either.
 */
export async function stageTurnAttachments(
  params: StageAttachmentsParams,
): Promise<Map<number, StagedAttachment>> {
  const staged = new Map<number, StagedAttachment>();
  const toWrite = params.plan
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.disposition === "stage");
  if (toWrite.length === 0) {
    return staged;
  }

  const chatDir = join(
    hostWorkspaceFor(params.sandboxState),
    ATTACHMENT_DIR_NAME,
    sanitizeAttachmentFilename(params.chatId),
  );
  const turnDir = join(
    chatDir,
    sanitizeAttachmentFilename(params.userMessageId),
  );

  try {
    await mkdir(turnDir, { recursive: true });
    await pruneOtherTurns(chatDir, turnDir);
  } catch (error) {
    console.error(
      "[attachments] could not prepare the staging directory",
      error,
    );
    return staged;
  }

  for (const { entry, index } of toWrite) {
    const { attachment } = entry;
    if (attachment.kind === "remote") {
      continue;
    }
    const target = join(
      turnDir,
      sanitizeAttachmentFilename(attachment.filename),
    );
    const bytes =
      attachment.kind === "text"
        ? new TextEncoder().encode(attachment.content)
        : decodeBase64(attachment.base64);
    if (!bytes) {
      continue;
    }
    try {
      // `0o600`: the same posture as the MCP config file — this is the
      // user's pasted log, and the agent's own `Bash` tool runs as this
      // account, not as every account on the machine.
      await writeFile(target, bytes, { mode: 0o600 });
      staged.set(index, { path: target, byteSize: bytes.byteLength });
    } catch (error) {
      console.error(`[attachments] could not write ${target}`, error);
    }
  }

  return staged;
}

/**
 * Drop every other turn's attachments for this chat.
 *
 * Only the newest user message's attachments are ever named in a prompt, so
 * older ones are dead weight that would otherwise accumulate for the life of
 * the workspace — a chat where someone pastes a log every turn would keep
 * every copy. Pruning on write rather than on teardown means the cleanup
 * happens even when a workflow crashes, which is exactly when a teardown
 * hook would not run.
 */
async function pruneOtherTurns(
  chatDir: string,
  turnDir: string,
): Promise<void> {
  const entries = await readdir(chatDir).catch(() => [] as string[]);
  await Promise.all(
    entries
      .map((entry) => join(chatDir, entry))
      .filter((path) => path !== turnDir)
      .map((path) =>
        rm(path, { recursive: true, force: true }).catch((error: unknown) => {
          console.error(`[attachments] could not prune ${path}`, error);
        }),
      ),
  );
}

/** Base64 → bytes, without assuming `Buffer` is in scope. */
function decodeBase64(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch (error) {
    console.error("[attachments] could not decode a data URL payload", error);
    return null;
  }
}
