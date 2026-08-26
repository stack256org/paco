import { describe, expect, test } from "bun:test";
import {
  ATTACHMENT_INLINE_BYTE_BUDGET,
  ATTACHMENT_TOTAL_INLINE_BYTE_BUDGET,
  composeTurnPrompt,
  decodeDataUrl,
  planAttachments,
  type PromptAttachment,
  renderAttachmentSection,
  sanitizeAttachmentFilename,
  type StagedAttachment,
} from "./attachment-prompt";

function textAttachment(filename: string, content: string): PromptAttachment {
  return { kind: "text", filename, content };
}

describe("planAttachments", () => {
  test("inlines a small text attachment", () => {
    const plan = planAttachments([textAttachment("notes.txt", "hello")]);
    expect(plan[0]?.disposition).toBe("inline");
  });

  test("stages a text attachment past the per-attachment budget", () => {
    const plan = planAttachments([
      textAttachment("huge.log", "x".repeat(ATTACHMENT_INLINE_BYTE_BUDGET + 1)),
    ]);
    expect(plan[0]?.disposition).toBe("stage");
  });

  test("counts multibyte characters by their UTF-8 size, not their length", () => {
    // A budget measured in `String.length` would let a file three times the
    // intended size through — the model is billed for bytes, not code units.
    const emoji = "😀".repeat(ATTACHMENT_INLINE_BYTE_BUDGET / 4);
    const plan = planAttachments([textAttachment("emoji.txt", emoji)]);
    expect(plan[0]?.disposition).toBe("inline");

    const overBudget = `${emoji}😀`;
    expect(
      planAttachments([textAttachment("emoji.txt", overBudget)])[0]
        ?.disposition,
    ).toBe("stage");
  });

  test("stops inlining once the whole message's budget is spent", () => {
    // Ten attachments each under the per-attachment budget still add up, and
    // the point of the budget is the size of the turn, not of one file.
    const each = "x".repeat(ATTACHMENT_INLINE_BYTE_BUDGET);
    const count = ATTACHMENT_TOTAL_INLINE_BYTE_BUDGET / each.length + 2;
    const plan = planAttachments(
      Array.from({ length: count }, (_, index) =>
        textAttachment(`file-${index}.log`, each),
      ),
    );

    const inlined = plan.filter((entry) => entry.disposition === "inline");
    expect(inlined.length).toBe(
      ATTACHMENT_TOTAL_INLINE_BYTE_BUDGET / each.length,
    );
    // The ones the user picked first are the ones that survive.
    expect(plan.at(-1)?.disposition).toBe("stage");
  });

  test("never inlines a binary attachment", () => {
    const plan = planAttachments([
      {
        kind: "binary",
        filename: "a.png",
        mediaType: "image/png",
        base64: "AA==",
      },
    ]);
    expect(plan[0]?.disposition).toBe("stage");
  });
});

describe("sanitizeAttachmentFilename", () => {
  test("cannot escape the directory it is joined onto", () => {
    expect(sanitizeAttachmentFilename("../../.ssh/authorized_keys")).toBe(
      "authorized_keys",
    );
    expect(sanitizeAttachmentFilename("..")).toBe("attachment");
    expect(sanitizeAttachmentFilename("/etc/passwd")).toBe("passwd");
    expect(sanitizeAttachmentFilename("..\\..\\windows\\system32")).toBe(
      "system32",
    );
  });

  test("keeps a name usable and never returns an empty one", () => {
    expect(sanitizeAttachmentFilename("pasted.log")).toBe("pasted.log");
    expect(sanitizeAttachmentFilename("my report v2.txt")).toBe(
      "my-report-v2.txt",
    );
    expect(sanitizeAttachmentFilename("")).toBe("attachment");
    expect(sanitizeAttachmentFilename("$(id).txt")).toBe("--id-.txt");
    expect(sanitizeAttachmentFilename("a".repeat(500)).length).toBe(120);
  });
});

describe("decodeDataUrl", () => {
  test("splits a base64 data URL", () => {
    expect(decodeDataUrl("data:image/png;base64,AAAB")).toEqual({
      mediaType: "image/png",
      base64: "AAAB",
    });
  });

  test("returns null for anything it cannot decode into bytes", () => {
    expect(decodeDataUrl("https://example.com/a.png")).toBeNull();
    expect(decodeDataUrl("data:text/plain,hello")).toBeNull();
  });
});

describe("renderAttachmentSection", () => {
  const noneStaged: ReadonlyMap<number, StagedAttachment> = new Map();

  test("puts an inlined attachment's filename and contents in the prompt", () => {
    const plan = planAttachments([textAttachment("pasted.log", "ERROR boom")]);
    const section = renderAttachmentSection(plan, noneStaged);
    expect(section).toContain("pasted.log");
    expect(section).toContain("ERROR boom");
  });

  test("fences around content that contains its own backticks", () => {
    // A pasted markdown file otherwise closes the block early and the rest
    // of it reads as instructions rather than as content.
    const content = "```js\nconst a = 1;\n```";
    const plan = planAttachments([textAttachment("readme.md", content)]);
    const section = renderAttachmentSection(plan, noneStaged);
    expect(section).toContain("````");
    expect(section).toContain(content);
  });

  test("names the path, not the contents, for a staged attachment", () => {
    const content = `${"x".repeat(ATTACHMENT_INLINE_BYTE_BUDGET)}NEEDLE`;
    const plan = planAttachments([textAttachment("huge.log", content)]);
    const section = renderAttachmentSection(
      plan,
      new Map([[0, { path: "/tmp/stage/huge.log", byteSize: content.length }]]),
    );

    expect(section).toContain("/tmp/stage/huge.log");
    expect(section).toContain("Read");
    expect(section).not.toContain("NEEDLE");
    expect(section.length).toBeLessThan(content.length / 4);
  });

  test("says so when a staged attachment could not be written", () => {
    // Losing the attachment silently is the whole defect. The model has to
    // be able to say "I could not read that" instead of answering as though
    // it had.
    const content = "y".repeat(ATTACHMENT_INLINE_BYTE_BUDGET + 1);
    const plan = planAttachments([textAttachment("huge.log", content)]);
    const section = renderAttachmentSection(plan, noneStaged);
    expect(section).toContain("huge.log");
    expect(section).toContain("NOT available");
  });

  test("names a remote attachment rather than dropping it", () => {
    const plan = planAttachments([
      {
        kind: "remote",
        filename: "shot.png",
        mediaType: "image/png",
        url: "https://example.com/shot.png",
      },
    ]);
    const section = renderAttachmentSection(plan, noneStaged);
    expect(section).toContain("https://example.com/shot.png");
  });

  test("is empty when there is nothing attached", () => {
    expect(renderAttachmentSection([], noneStaged)).toBe("");
  });
});

describe("composeTurnPrompt", () => {
  test("keeps a plain message untouched", () => {
    expect(composeTurnPrompt("Hello", "")).toBe("Hello");
  });

  test("sends the attachment alone when the user typed nothing", () => {
    expect(composeTurnPrompt("", "## Attachment")).toBe("## Attachment");
  });
});
