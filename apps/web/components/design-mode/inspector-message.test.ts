import { describe, expect, test } from "bun:test";
import {
  DESIGN_INSPECT_ARM_MESSAGE,
  parseInspectClickMessage,
} from "./inspector-message";

describe("parseInspectClickMessage", () => {
  test("accepts what design-inspector.js actually posts", () => {
    const parsed = parseInspectClickMessage({
      type: "paco-inspect-click",
      selector: "#hero > h1:nth-of-type(1)",
      text: "Welcome",
      rect: { x: 0, y: 0, width: 10, height: 10, top: 0, left: 0 },
    });

    expect(parsed).toEqual({
      type: "paco-inspect-click",
      selector: "#hero > h1:nth-of-type(1)",
      text: "Welcome",
    });
  });

  test("accepts an element with no text of its own", () => {
    expect(
      parseInspectClickMessage({
        type: "paco-inspect-click",
        selector: "#logo",
        text: "",
      })?.text,
    ).toBe("");
  });

  test("rejects another message type", () => {
    expect(parseInspectClickMessage({ type: "paco-inspect-arm" })).toBeNull();
  });

  test("rejects a payload with no selector", () => {
    expect(
      parseInspectClickMessage({ type: "paco-inspect-click", text: "hi" }),
    ).toBeNull();
    expect(
      parseInspectClickMessage({
        type: "paco-inspect-click",
        selector: "",
        text: "hi",
      }),
    ).toBeNull();
  });

  test("rejects anything that is not an object", () => {
    expect(parseInspectClickMessage(null)).toBeNull();
    expect(parseInspectClickMessage("paco-inspect-click")).toBeNull();
    expect(parseInspectClickMessage(undefined)).toBeNull();
  });
});

describe("DESIGN_INSPECT_ARM_MESSAGE", () => {
  test("is the exact message design-inspector.js arms on", () => {
    expect(DESIGN_INSPECT_ARM_MESSAGE).toEqual({ type: "paco-inspect-arm" });
  });
});
