import { describe, expect, test } from "bun:test";
import { formatBytes, pluralize } from "./format-bytes";

describe("formatBytes", () => {
  test("matches what du -h would print for the sizes that matter", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(81_920)).toBe("80 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
  });

  test("drops the decimal above 100 of a unit, where it is noise", () => {
    expect(formatBytes(650 * 1024 * 1024)).toBe("650 MB");
  });

  test("never invents a number for a missing measurement", () => {
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
  });
});

describe("pluralize", () => {
  test("never says 1 containers", () => {
    expect(pluralize(1, "container", "containers")).toBe("1 container");
    expect(pluralize(0, "container", "containers")).toBe("0 containers");
    expect(pluralize(8, "container", "containers")).toBe("8 containers");
  });
});
