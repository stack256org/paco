import { formatByteSize } from "@/lib/text-attachment-utils";

/**
 * Turning a message's attachments into prompt text.
 *
 * The composer produces two kinds of attachment part: `data-snippet` (an
 * uploaded text file, or a paste large enough for `text-attachment-utils.ts`
 * to promote into one) and `file` (an image, carried as a data URL). Neither
 * is text, so neither survives being read off a message as text — which is
 * exactly how their contents stopped reaching the model.
 *
 * Everything here is pure and free of Node imports: the chat workflow body
 * runs in the Workflow SDK's sandboxed VM, and the staging half that does
 * touch the filesystem lives in `attachment-staging.ts`, behind a dynamic
 * import from inside a `"use step"`.
 */

/**
 * How much of a single text attachment goes into the prompt verbatim.
 *
 * Attachments are usually logs, and a log is exactly the thing a user pastes
 * without looking at its size. Inlining one whole is not "the content
 * reached the model" — it is a turn that costs a fortune or gets rejected
 * for length. Past this, the content is written to disk and the prompt names
 * the path instead, which the agent's own `Read`/`Grep` tools can work
 * through on demand and only for the parts that matter.
 *
 * 16 KiB is roughly 4k tokens: small enough that a handful of them cannot
 * dominate a turn, large enough that the ordinary case — a stack trace, a
 * failing test's output, a config file — still arrives whole and costs the
 * agent no tool calls to read.
 */
export const ATTACHMENT_INLINE_BYTE_BUDGET = 16 * 1024;

/**
 * The same bound across every attachment on one message, so ten 15 KiB files
 * cannot each pass the per-attachment budget and together blow the turn.
 * Attachments are considered in order, so the first ones the user picked are
 * the ones that get inlined.
 */
export const ATTACHMENT_TOTAL_INLINE_BYTE_BUDGET = 64 * 1024;

/**
 * How much of a staged attachment's head is quoted in the prompt.
 *
 * Enough for the agent to recognise the format and decide how to search it,
 * not so much that a staged attachment costs what inlining it would have.
 */
export const ATTACHMENT_EXCERPT_CHAR_LIMIT = 2 * 1024;

/** A text attachment: a `data-snippet` part's filename and contents. */
export type TextPromptAttachment = {
  kind: "text";
  filename: string;
  content: string;
};

/** A binary attachment (an image), decoded from its data URL. */
export type BinaryPromptAttachment = {
  kind: "binary";
  filename: string;
  mediaType: string;
  /** Base64 payload, exactly as it appeared in the data URL. */
  base64: string;
};

/**
 * A `file` part whose `url` is not a data URL, so there is nothing local to
 * write. Rare — the composer produces data URLs — but a message can be
 * replayed from a persisted transcript, so the case is real and gets an
 * honest line in the prompt rather than silent omission.
 */
export type RemotePromptAttachment = {
  kind: "remote";
  filename: string;
  mediaType: string;
  url: string;
};

export type PromptAttachment =
  | TextPromptAttachment
  | BinaryPromptAttachment
  | RemotePromptAttachment;

/**
 * What is to be done with one attachment.
 *
 * `inline` puts the content in the prompt. `stage` writes it to disk and
 * names the path. `reference` has nothing to write and only names the URL.
 */
export type AttachmentDisposition = "inline" | "stage" | "reference";

export type AttachmentPlanEntry = {
  attachment: PromptAttachment;
  disposition: AttachmentDisposition;
};

/** UTF-8 size of a string, which is what a file on disk will actually cost. */
export function utf8ByteSize(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Strip a client-supplied filename down to something safe to join onto a
 * directory path.
 *
 * The filename comes from the browser and is used to build a path, so it is
 * untrusted input in the most literal sense: `../../.ssh/authorized_keys`
 * has to come out as a plain name in the attachment directory, not a
 * traversal. Everything outside a conservative character set is replaced
 * rather than dropped, so two different names cannot silently collapse onto
 * each other by having their special characters removed.
 */
export function sanitizeAttachmentFilename(filename: string): string {
  // Basename only: separators of either flavour end the traversal question
  // before the character filter has to be trusted with it.
  const base = filename.split(/[/\\]/).pop() ?? "";
  // Anything outside `[A-Za-z0-9_.-]` becomes a dash — control characters,
  // spaces and shell metacharacters included — and leading dots go, so a
  // name can never address a parent directory or hide in a listing.
  const cleaned = base.replace(/^\.+/, "").replace(/[^\w.-]/g, "-");
  const safe = cleaned.slice(0, 120);
  return safe.length > 0 ? safe : "attachment";
}

/**
 * Decide, in order, which attachments are inlined and which are staged.
 *
 * Binary attachments are never inlined — base64 in a prompt is unreadable to
 * the model and enormous — so an image always becomes a path, which is the
 * form the agent's `Read` tool understands for images.
 *
 * Staged either way, even for a backend whose model cannot see images: the
 * file on disk is still useful for everything about an image that is not
 * looking at it, and `renderAttachmentSection` is where the difference is
 * told to the model. See `RenderAttachmentOptions`.
 */
export function planAttachments(
  attachments: readonly PromptAttachment[],
): AttachmentPlanEntry[] {
  let inlinedBytes = 0;
  return attachments.map((attachment) => {
    if (attachment.kind === "remote") {
      return { attachment, disposition: "reference" as const };
    }
    if (attachment.kind === "binary") {
      return { attachment, disposition: "stage" as const };
    }

    const byteSize = utf8ByteSize(attachment.content);
    if (
      byteSize <= ATTACHMENT_INLINE_BYTE_BUDGET &&
      inlinedBytes + byteSize <= ATTACHMENT_TOTAL_INLINE_BYTE_BUDGET
    ) {
      inlinedBytes += byteSize;
      return { attachment, disposition: "inline" as const };
    }
    return { attachment, disposition: "stage" as const };
  });
}

/** Where a staged attachment ended up, keyed back to its plan entry. */
export type StagedAttachment = {
  path: string;
  byteSize: number;
};

/**
 * A code fence wide enough that the attachment's own backticks cannot close
 * it — a pasted markdown file otherwise ends the block early and the rest of
 * it reads as instructions rather than as content.
 */
function fenceFor(content: string): string {
  let longest = 0;
  for (const run of content.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

function excerptOf(content: string): string {
  if (content.length <= ATTACHMENT_EXCERPT_CHAR_LIMIT) {
    return content;
  }
  return content.slice(0, ATTACHMENT_EXCERPT_CHAR_LIMIT);
}

function countLines(content: string): number {
  let lines = 1;
  for (const character of content) {
    if (character === "\n") {
      lines++;
    }
  }
  return lines;
}

function renderInline(attachment: TextPromptAttachment): string {
  const fence = fenceFor(attachment.content);
  return [
    `### ${attachment.filename} (${formatByteSize(utf8ByteSize(attachment.content))})`,
    fence,
    attachment.content,
    fence,
  ].join("\n");
}

function renderStagedText(
  attachment: TextPromptAttachment,
  staged: StagedAttachment,
): string {
  const fence = fenceFor(attachment.content);
  return [
    `### ${attachment.filename} (${formatByteSize(staged.byteSize)}, ${countLines(
      attachment.content,
    )} lines) — saved to ${staged.path}`,
    "Too large to include here. Read it from that path (`Read` with `offset`/`limit`, or `Grep`) rather than working from the excerpt below, which is only its first few lines:",
    fence,
    excerptOf(attachment.content),
    fence,
  ].join("\n");
}

/**
 * What the rendering needs to know about the backend that will read it.
 *
 * One field today, and an options object rather than a bare boolean because
 * "the third positional argument is a boolean" is unreadable at every call
 * site and because the next capability that changes this text should not
 * change this signature again.
 */
export type RenderAttachmentOptions = {
  /**
   * `BackendCapabilities.images` for the backend this turn runs on.
   *
   * Defaults to `true` — the assumption every caller written before this
   * option existed was built on, and the one Claude Code satisfies — so an
   * omission cannot quietly degrade a turn that was working.
   */
  canViewImages: boolean;
};

const DEFAULT_RENDER_OPTIONS: RenderAttachmentOptions = { canViewImages: true };

function renderStagedBinary(
  attachment: BinaryPromptAttachment,
  staged: StagedAttachment,
  options: RenderAttachmentOptions,
): string {
  const heading = `### ${attachment.filename} (${attachment.mediaType}, ${formatByteSize(staged.byteSize)}) — saved to ${staged.path}`;
  if (options.canViewImages) {
    return [heading, "Use `Read` on that path to view it."].join("\n");
  }
  /*
   * The file is still written and still named, because plenty of real work
   * on an image needs no eyes — moving it into the repo, checking its size,
   * converting it, wiring it into a page. Dropping it would take away a
   * capability the backend genuinely has.
   *
   * What must not survive is the instruction to `Read` it "to view it".
   * On Poolside that call fails outright, and an inline image block is
   * dropped without even an error, so a prompt that implies the picture
   * arrived is the exact silent failure the unstaged fallback below was
   * written to avoid. Same rule, applied one step earlier: state what is
   * NOT available.
   */
  return [
    heading,
    'You cannot see images: this chat\'s backend runs a model that does not accept image input, and `Read` on that path fails with "the configured model does not support image inputs".',
    "The file is on disk, so non-visual work on it still works — but WHAT IT DEPICTS IS NOT available to you. Do not describe, infer or guess at its contents. Ask the user to describe what it shows, or to paste the part that matters as text.",
  ].join("\n");
}

/**
 * Fallback when staging failed (an unwritable workspace, a filesystem
 * error). Losing the attachment silently is the bug this whole module
 * exists to fix, so what is left is the head of it plus a statement that the
 * rest is missing — the model can then say so instead of answering as
 * though it had read the file.
 */
function renderUnstaged(
  attachment: PromptAttachment,
  options: RenderAttachmentOptions,
): string {
  if (attachment.kind === "text") {
    const fence = fenceFor(attachment.content);
    const truncated = attachment.content.length > ATTACHMENT_EXCERPT_CHAR_LIMIT;
    return [
      `### ${attachment.filename} (${formatByteSize(utf8ByteSize(attachment.content))})`,
      ...(truncated
        ? [
            "Could not be saved to disk, so only its first few lines are available here — the rest of this file is NOT available to you:",
          ]
        : []),
      fence,
      excerptOf(attachment.content),
      fence,
    ].join("\n");
  }
  if (attachment.kind === "binary") {
    return [
      `### ${attachment.filename} (${attachment.mediaType})`,
      options.canViewImages
        ? "The user attached this file, but it could not be saved anywhere you can read it. Say so rather than guessing at its contents."
        : "The user attached this file. It could not be saved anywhere you can read it, and you cannot see images anyway — this chat's backend runs a model that does not accept image input. Its contents are NOT available to you. Ask the user to describe what it shows rather than guessing.",
    ].join("\n");
  }
  return renderReference(attachment);
}

function renderReference(attachment: RemotePromptAttachment): string {
  const name = attachment.filename || attachment.mediaType;
  return [
    `### ${name} (${attachment.mediaType})`,
    `The user attached this from ${attachment.url}. Fetch it if you need its contents.`,
  ].join("\n");
}

/**
 * Render the attachment section appended to the newest user message's text.
 *
 * `staged` is indexed by position in `plan`; an entry missing from it is one
 * whose write failed, which degrades to {@link renderUnstaged} rather than
 * dropping the attachment.
 */
export function renderAttachmentSection(
  plan: readonly AttachmentPlanEntry[],
  staged: ReadonlyMap<number, StagedAttachment>,
  options: RenderAttachmentOptions = DEFAULT_RENDER_OPTIONS,
): string {
  if (plan.length === 0) {
    return "";
  }

  const sections = plan.map((entry, index) => {
    const written = staged.get(index);
    if (
      entry.disposition === "reference" &&
      entry.attachment.kind === "remote"
    ) {
      return renderReference(entry.attachment);
    }
    if (entry.disposition === "inline" && entry.attachment.kind === "text") {
      return renderInline(entry.attachment);
    }
    if (!written) {
      return renderUnstaged(entry.attachment, options);
    }
    if (entry.attachment.kind === "text") {
      return renderStagedText(entry.attachment, written);
    }
    if (entry.attachment.kind === "binary") {
      return renderStagedBinary(entry.attachment, written, options);
    }
    return renderReference(entry.attachment);
  });

  const heading =
    plan.length === 1
      ? "## Attachment\n\nThe user attached this to the message above."
      : `## Attachments\n\nThe user attached these ${plan.length} files to the message above.`;

  return [heading, ...sections].join("\n\n");
}

/** Join a user's own text with the attachment section, dropping empty halves. */
export function composeTurnPrompt(text: string, section: string): string {
  return [text.trim(), section.trim()].filter(Boolean).join("\n\n");
}

/**
 * Split a `data:` URL into its media type and base64 payload.
 *
 * Returns `null` for anything else — an `http(s)` URL, or a `data:` URL that
 * is percent-encoded rather than base64 — so the caller can fall back to
 * naming it instead of writing a corrupt file.
 */
export function decodeDataUrl(
  url: string,
): { mediaType: string; base64: string } | null {
  // `[\s\S]` rather than `.` with the `s` flag: this file compiles under the
  // app's ES2017 target, where that flag does not exist.
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,([\s\S]*)$/.exec(url);
  if (!match) {
    return null;
  }
  const [, mediaType, base64] = match;
  if (!base64) {
    return null;
  }
  return { mediaType: mediaType || "application/octet-stream", base64 };
}
