import { describe, expect, mock, test } from "bun:test";
import type { BackendCapabilities } from "@paco/agent-backend";
import { ClaudeCodeBackend } from "@paco/claude-code";
import { PoolsideBackend } from "@paco/poolside-backend";
import { renderToStaticMarkup } from "react-dom/server";

// `agents-page-content` pulls in the page's server actions and toaster at
// module scope; neither is exercised by the notice, which takes everything
// it renders as props.
mock.module("./actions", () => ({
  deleteRoster: () => Promise.resolve({ success: true }),
  listRosterAgents: () => Promise.resolve([]),
  saveRosterAgent: () => Promise.resolve({ success: true }),
  setRosterEnabled: () => Promise.resolve({ success: true }),
}));
mock.module("@/lib/toast", () => ({
  toast: { error: () => {}, success: () => {} },
}));

const modulePromise = import("./agents-page-content");

/** See `roster-backend-support.test.ts` on why these are read, not written. */
const CLAUDE: BackendCapabilities = new ClaudeCodeBackend().capabilities();
const POOLSIDE: BackendCapabilities = new PoolsideBackend().capabilities();

const ROSTER_MODEL_IDS = ["sonnet", "opus", "haiku"];

async function render(
  backends: readonly BackendCapabilities[],
  rosterModelIds: readonly string[] = ROSTER_MODEL_IDS,
) {
  const { RosterBackendNotice } = await modulePromise;

  return renderToStaticMarkup(
    <RosterBackendNotice backends={backends} rosterModelIds={rosterModelIds} />,
  );
}

describe("RosterBackendNotice", () => {
  test("shows the notice when a backend reports it cannot install a roster", async () => {
    const markup = await render([CLAUDE, POOLSIDE]);

    expect(markup).toContain("Poolside");
    expect(markup).toContain("delegates to its own agents instead");
    expect(markup).toContain("Claude Code");
  });

  test("shows nothing when every backend takes the roster", async () => {
    const markup = await render([CLAUDE]);

    expect(markup).toBe("");
  });

  test("is driven by capabilities, not by the backend id", async () => {
    // Poolside's id, claiming support. A notice keyed on the name would
    // still render here.
    const markup = await render([{ ...POOLSIDE, customAgents: true }]);

    expect(markup).toBe("");
  });

  test("still names a backend the label map has never heard of", async () => {
    const markup = await render([
      CLAUDE,
      { ...POOLSIDE, id: "some-future-backend" },
    ]);

    expect(markup).toContain("some-future-backend");
  });

  test("says the roster's model tiers mean nothing to that backend", async () => {
    const markup = await render([CLAUDE, POOLSIDE]);

    expect(markup).toContain("haiku, opus and sonnet");
    expect(markup).toContain("per-agent model tiers");
  });

  test("omits the model sentence before the roster has loaded", async () => {
    const markup = await render([CLAUDE, POOLSIDE], []);

    expect(markup).toContain("delegates to its own agents instead");
    expect(markup).not.toContain("per-agent model tiers");
  });
});
