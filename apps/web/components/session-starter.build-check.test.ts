import { describe, expect, test } from "bun:test";

/**
 * The two mode tabs must not read like the submit button.
 *
 * The starter has a mode toggle — pick a blank workspace or a repository —
 * and, below it, one button that starts whatever was picked. Those tabs used
 * to read "New Chat" and "Start Session" while the button read "Start
 * session", so the screen offered two near-identical calls to action that did
 * entirely different things.
 *
 * That is not cosmetic. The starter opens in blank-workspace mode whenever
 * there is no previous repository to fall back on — a fresh install, or any
 * account that has not started a repo session yet — so someone who wanted to
 * work on a repository, saw "Start session", and pressed it got a session
 * with no repository cloned and no indication anything was missed. Paco's
 * whole job is working on code, so the mode chosen by accident is the one
 * that does the least.
 *
 * Asserted against the source rather than a render: the component's own tests
 * would need SWR, the session hook, the GitHub-connection hook and the
 * preferences hook stubbed to reach three string literals, and the invariant
 * being protected is about the strings themselves.
 */

const SOURCE = await Bun.file(
  new URL("session-starter.tsx", import.meta.url),
).text();

/** The label rendered on the submit button when no repository is selected. */
const SUBMIT_LABEL = /: "([^"]+)";\s*\n\s*return \(/;

function modeTabLabels(source: string): string[] {
  // Each tab is `<Icon ... />` followed by its text, then `</button>`.
  const matches = source.matchAll(
    /className="h-3\.5 w-3\.5" \/>\s*\n\s*([^<\n]+)\n\s*<\/button>/g,
  );
  return [...matches].map((match) => (match[1] ?? "").trim());
}

describe("session starter labels", () => {
  test("both mode tabs are found, so this test cannot pass vacuously", () => {
    expect(modeTabLabels(SOURCE)).toHaveLength(2);
  });

  test("no mode tab reads like the submit button", () => {
    const submit = SOURCE.match(SUBMIT_LABEL)?.[1];
    expect(submit).toBeDefined();

    const normalize = (value: string) => value.toLowerCase().trim();
    const submitLabel = normalize(submit as string);

    for (const tab of modeTabLabels(SOURCE)) {
      expect(normalize(tab)).not.toBe(submitLabel);
    }
  });

  test("the repository tab says it is about a repository", () => {
    // The failure mode was a tab whose name described the ACTION ("Start
    // Session") rather than what it selects, which is what made it
    // interchangeable with the button.
    const tabs = modeTabLabels(SOURCE).map((tab) => tab.toLowerCase());
    expect(tabs.some((tab) => tab.includes("repositor"))).toBe(true);
  });
});
