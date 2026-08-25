import { describe, expect, test } from "bun:test";
import type { WebAgentUIMessage } from "@/app/types";
import {
  designCandidateViews,
  designTurnMessageId,
  isDesignTurn,
} from "./candidate-progress";

function progressPart(
  candidate: number,
  status: "running" | "committing" | "completed" | "failed",
  error?: string,
): WebAgentUIMessage["parts"][number] {
  return {
    type: "data-design-progress",
    id: `design-candidate-${candidate}`,
    data: { candidate, status, ...(error ? { error } : {}) },
  };
}

function assistant(
  parts: WebAgentUIMessage["parts"],
  id = "assistant-1",
): WebAgentUIMessage {
  return { id, role: "assistant", parts };
}

const previews = [
  { index: 1 as const, url: "https://chat-d1.example.com" },
  { index: 2 as const, url: "https://chat-d2.example.com" },
  { index: 3 as const, url: "https://chat-d3.example.com" },
];

describe("isDesignTurn", () => {
  test("is true once the latest assistant message carries progress parts", () => {
    expect(isDesignTurn([assistant([progressPart(1, "running")])])).toBe(true);
  });

  test("is false for an ordinary turn", () => {
    expect(isDesignTurn([assistant([{ type: "text", text: "hi" }])])).toBe(
      false,
    );
  });

  test("survives an ordinary chat turn taken after the design turn", () => {
    // This used to be false, and it is the whole reason candidates could
    // become unreclaimable: the panel — and with it the only Discard control
    // in the product — rendered from the NEWEST assistant message, so one
    // ordinary reply after a design turn hid it permanently while two or
    // three worktrees and branches stayed on disk.
    expect(
      isDesignTurn([
        assistant([progressPart(1, "completed")], "old"),
        assistant([{ type: "text", text: "later" }], "new"),
      ]),
    ).toBe(true);
  });

  test("anchors on the design turn itself, not on the newest message", () => {
    expect(
      designTurnMessageId([
        assistant([progressPart(1, "completed")], "design"),
        assistant([{ type: "text", text: "later" }], "chat"),
      ]),
    ).toBe("design");
  });

  test("the newest design turn wins when there have been several", () => {
    expect(
      designTurnMessageId([
        assistant([progressPart(1, "completed")], "first"),
        assistant([{ type: "text", text: "in between" }], "chat"),
        assistant([progressPart(1, "running")], "second"),
      ]),
    ).toBe("second");
  });

  test("is false for an empty conversation", () => {
    expect(isDesignTurn([])).toBe(false);
  });
});

describe("designCandidateViews", () => {
  test("renders one view per streamed candidate, in index order", () => {
    const views = designCandidateViews(
      [assistant([progressPart(2, "running"), progressPart(1, "completed")])],
      previews,
    );

    expect(views.map((view) => view.index)).toEqual([1, 2]);
    expect(views[0].status).toBe("completed");
    expect(views[1].status).toBe("running");
  });

  test("the latest part for a candidate wins", () => {
    const views = designCandidateViews(
      [
        assistant([
          progressPart(1, "running"),
          progressPart(1, "committing"),
          progressPart(1, "completed"),
        ]),
      ],
      previews,
    );

    expect(views).toHaveLength(1);
    expect(views[0].status).toBe("completed");
  });

  test("carries a failed candidate's reason", () => {
    const views = designCandidateViews(
      [assistant([progressPart(3, "failed", "ran out of turns")])],
      previews,
    );

    expect(views[0].status).toBe("failed");
    expect(views[0].error).toBe("ran out of turns");
  });

  test("attaches each candidate's own preview URL", () => {
    const views = designCandidateViews(
      [assistant([progressPart(2, "completed")])],
      previews,
    );

    expect(views[0].previewUrl).toBe("https://chat-d2.example.com");
  });

  test("leaves the preview URL null when previews are not configured", () => {
    const views = designCandidateViews(
      [assistant([progressPart(2, "completed")])],
      [],
    );

    expect(views[0].previewUrl).toBeNull();
  });

  test("is empty for an ordinary turn", () => {
    expect(
      designCandidateViews(
        [assistant([{ type: "text", text: "hi" }])],
        previews,
      ),
    ).toEqual([]);
  });

  test("still renders the design turn's candidates after an ordinary reply", () => {
    const views = designCandidateViews(
      [
        assistant([progressPart(1, "completed"), progressPart(2, "completed")]),
        assistant([{ type: "text", text: "sure, here you go" }], "later"),
      ],
      previews,
    );

    expect(views.map((view) => view.index)).toEqual([1, 2]);
  });

  test("an older design turn's parts never leak into a newer one", () => {
    // The reason the original only ever looked at the newest message: two
    // design turns in one chat must not merge into one panel.
    const views = designCandidateViews(
      [
        assistant([progressPart(3, "completed")], "first"),
        assistant([progressPart(1, "running")], "second"),
      ],
      previews,
    );

    expect(views.map((view) => view.index)).toEqual([1]);
  });
});
