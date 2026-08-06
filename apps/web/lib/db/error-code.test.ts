import { describe, expect, test } from "bun:test";
import { getErrorCode } from "./error-code";

describe("getErrorCode", () => {
  test("reads the code directly off a plain postgres error", () => {
    expect(getErrorCode({ code: "42P01" })).toBe("42P01");
  });

  test("recurses into cause for a DrizzleQueryError-shaped wrapper", () => {
    // Verified against the live database: a real DrizzleQueryError reports
    // `code: undefined` at the top level and the SQLSTATE on `cause.code`.
    const error = {
      name: "DrizzleQueryError",
      code: undefined,
      cause: {
        code: "42P01",
        message: 'relation "pgboss.job" does not exist',
      },
    };
    expect(getErrorCode(error)).toBe("42P01");
  });

  test("recurses through more than one level of cause", () => {
    const error = { cause: { cause: { code: "3F000" } } };
    expect(getErrorCode(error)).toBe("3F000");
  });

  test("returns undefined when there is no code anywhere in the chain", () => {
    expect(getErrorCode(new Error("boom"))).toBeUndefined();
  });

  test("returns undefined for non-object input", () => {
    expect(getErrorCode("boom")).toBeUndefined();
    expect(getErrorCode(null)).toBeUndefined();
    expect(getErrorCode(undefined)).toBeUndefined();
  });
});
