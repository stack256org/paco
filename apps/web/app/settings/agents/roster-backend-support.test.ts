import { describe, expect, test } from "bun:test";
import type { BackendCapabilities } from "@paco/agent-backend";
import { ClaudeCodeBackend } from "@paco/claude-code";
import { PoolsideBackend } from "@paco/poolside-backend";
import {
  backendLabel,
  describeRosterBackendSupport,
  formatList,
} from "./roster-backend-support";

/**
 * The real backends, not hand-copied literals.
 *
 * The point of the notice this drives is that its copy is derived from what
 * a backend reports, and a transcribed fixture would reintroduce exactly the
 * drift the derivation removes — the package could start accepting a
 * caller's roster, its own tests would be updated, and these assertions
 * would keep passing against a shape that no longer exists.
 *
 * Both constructors are side-effect-free; only `startTurn` spawns anything,
 * which is the same property `lib/agent/backend-capabilities.ts` relies on.
 */
const CLAUDE: BackendCapabilities = new ClaudeCodeBackend().capabilities();
const POOLSIDE: BackendCapabilities = new PoolsideBackend().capabilities();

const ROSTER_MODEL_IDS = ["sonnet", "opus", "sonnet", "haiku"];

describe("describeRosterBackendSupport", () => {
  test("a backend that leaves customAgents undefined honours the roster", () => {
    // Not `false`: the interface defines `undefined` as "yes".
    expect(CLAUDE.customAgents).toBeUndefined();

    const support = describeRosterBackendSupport([CLAUDE], ROSTER_MODEL_IDS);

    expect(support.honouring).toEqual(["Claude Code"]);
    expect(support.ignoring).toEqual([]);
  });

  test("a backend reporting customAgents:false is listed as ignoring it", () => {
    expect(POOLSIDE.customAgents).toBe(false);

    const support = describeRosterBackendSupport([POOLSIDE], ROSTER_MODEL_IDS);

    expect(support.honouring).toEqual([]);
    expect(support.ignoring.map((backend) => backend.id)).toEqual(["poolside"]);
  });

  test("the split is driven by customAgents, not by the backend id", () => {
    // Same id Poolside reports, but claiming it takes a roster. If the split
    // were keyed on the name, this would still land in `ignoring`.
    const honestlyCapablePoolside: BackendCapabilities = {
      ...POOLSIDE,
      customAgents: true,
    };

    const support = describeRosterBackendSupport(
      [honestlyCapablePoolside],
      ROSTER_MODEL_IDS,
    );

    expect(support.ignoring).toEqual([]);
    expect(support.honouring).toEqual(["Poolside"]);
  });

  test("model tiers the ignoring backend does not accept are reported, deduped and sorted", () => {
    const support = describeRosterBackendSupport([POOLSIDE], ROSTER_MODEL_IDS);

    expect(support.ignoring[0]?.unknownModelIds).toEqual([
      "haiku",
      "opus",
      "sonnet",
    ]);
  });

  test("a tier the backend does accept is not reported as unknown", () => {
    const poolsideModel = POOLSIDE.models?.[0];
    expect(typeof poolsideModel).toBe("string");

    const support = describeRosterBackendSupport(
      [POOLSIDE],
      ["opus", poolsideModel as string],
    );

    expect(support.ignoring[0]?.unknownModelIds).toEqual(["opus"]);
  });

  test("models:undefined means the app catalog applies, so nothing is unknown", () => {
    const support = describeRosterBackendSupport(
      [{ ...POOLSIDE, models: undefined }],
      ROSTER_MODEL_IDS,
    );

    expect(support.ignoring[0]?.unknownModelIds).toEqual([]);
  });

  test("an EMPTY models list means the backend takes none of them", () => {
    const support = describeRosterBackendSupport(
      [{ ...POOLSIDE, models: [] }],
      ROSTER_MODEL_IDS,
    );

    expect(support.ignoring[0]?.unknownModelIds).toEqual([
      "haiku",
      "opus",
      "sonnet",
    ]);
  });

  test("an unlabelled backend id renders as itself rather than vanishing", () => {
    const support = describeRosterBackendSupport(
      [{ ...POOLSIDE, id: "some-future-backend" }],
      [],
    );

    expect(support.ignoring[0]?.label).toBe("some-future-backend");
    expect(backendLabel("some-future-backend")).toBe("some-future-backend");
  });

  test("both shipped backends together split one each", () => {
    const support = describeRosterBackendSupport(
      [CLAUDE, POOLSIDE],
      ROSTER_MODEL_IDS,
    );

    expect(support.honouring).toEqual(["Claude Code"]);
    expect(support.ignoring.map((backend) => backend.label)).toEqual([
      "Poolside",
    ]);
  });
});

describe("formatList", () => {
  test("joins without a dangling conjunction", () => {
    expect(formatList([])).toBe("");
    expect(formatList(["a"])).toBe("a");
    expect(formatList(["a", "b"])).toBe("a and b");
    expect(formatList(["a", "b", "c"])).toBe("a, b and c");
  });
});
