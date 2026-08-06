import { describe, expect, test } from "bun:test";
import { findConfigProblems } from "./required-env";

const GOOD = {
  APP_SECRET: "x".repeat(32),
  APP_URL: "http://localhost:3066",
};

function variables(env: Record<string, string | undefined>): string[] {
  return findConfigProblems(env).map((problem) => problem.variable);
}

describe("findConfigProblems", () => {
  test("says nothing when both are set correctly", () => {
    expect(findConfigProblems(GOOD)).toEqual([]);
  });

  test("accepts a deployed origin with no explicit port", () => {
    expect(
      findConfigProblems({
        ...GOOD,
        APP_URL: "https://paco.example",
      }),
    ).toEqual([]);
  });

  describe("APP_URL", () => {
    test("is not reported when missing", () => {
      expect(variables({ ...GOOD, APP_URL: undefined })).toEqual([]);
    });

    test("is not reported when blank", () => {
      expect(variables({ ...GOOD, APP_URL: "   " })).toEqual([]);
    });

    test("rejects a value with no scheme, which parses as a URL but has no host", () => {
      const [problem] = findConfigProblems({
        ...GOOD,
        APP_URL: "localhost:3066",
      });

      expect(problem?.variable).toBe("APP_URL");
      // The explanation has to name the trap, because the value looks right.
      expect(problem?.problem).toContain("reads as a scheme");
    });

    test("rejects a non-http scheme", () => {
      expect(variables({ ...GOOD, APP_URL: "ftp://paco.example" })).toEqual([
        "APP_URL",
      ]);
    });

    test("rejects something that is not a URL at all", () => {
      expect(variables({ ...GOOD, APP_URL: "not a url" })).toEqual(["APP_URL"]);
    });
  });

  describe("APP_SECRET", () => {
    test("is reported when missing", () => {
      expect(variables({ ...GOOD, APP_SECRET: undefined })).toEqual([
        "APP_SECRET",
      ]);
    });

    test("is reported when too short to be worth encrypting with", () => {
      const [problem] = findConfigProblems({ ...GOOD, APP_SECRET: "hunter2" });

      expect(problem?.variable).toBe("APP_SECRET");
      expect(problem?.problem).toContain("7 characters");
    });

    test("accepts exactly the minimum length", () => {
      expect(
        findConfigProblems({ ...GOOD, APP_SECRET: "y".repeat(32) }),
      ).toEqual([]);
    });
  });

  test("reports every problem at once, so one restart is enough", () => {
    expect(variables({ APP_SECRET: undefined, APP_URL: undefined })).toEqual([
      "APP_SECRET",
    ]);
  });

  test("every problem carries a fix worth acting on", () => {
    for (const problem of findConfigProblems({
      APP_SECRET: "short",
      APP_URL: "localhost:3066",
    })) {
      expect(problem.fix.length).toBeGreaterThan(20);
      expect(problem.problem.length).toBeGreaterThan(20);
    }
  });
});
