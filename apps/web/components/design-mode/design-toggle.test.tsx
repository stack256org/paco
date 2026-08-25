import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DesignToggle } from "./design-toggle";

const noop = () => {};

/**
 * `DesignToggle` is hook-free, so calling it directly returns its element
 * tree — the only way to reach an `onClick` in a repo whose test setup has
 * no DOM (see `lib/design/selector.test.ts`).
 */
function firstButton(node: ReactNode): {
  disabled?: boolean;
  onClick?: () => void;
} {
  let found: { disabled?: boolean; onClick?: () => void } | null = null;
  const visit = (element: ReactNode): void => {
    if (Array.isArray(element)) {
      for (const child of element) {
        visit(child as ReactNode);
      }
      return;
    }
    if (!isValidElement(element)) {
      return;
    }
    if (element.type === "button" && !found) {
      found = element.props as { disabled?: boolean; onClick?: () => void };
    }
    visit(
      ((element as ReactElement).props as { children?: ReactNode }).children,
    );
  };
  visit(node);
  if (!found) {
    throw new Error("The design toggle rendered no button");
  }
  return found;
}

describe("DesignToggle", () => {
  test("names itself so the control is not just an icon", () => {
    const html = renderToStaticMarkup(
      <DesignToggle active={false} disabled={false} onToggle={noop} />,
    );

    expect(html).toContain("Design");
    expect(html).toContain("btn");
  });

  test("is always visible, on or off", () => {
    const off = renderToStaticMarkup(
      <DesignToggle active={false} disabled={false} onToggle={noop} />,
    );
    const on = renderToStaticMarkup(
      <DesignToggle active={true} disabled={false} onToggle={noop} />,
    );

    expect(off).toContain('aria-pressed="false"');
    expect(on).toContain('aria-pressed="true"');
  });

  test("shows its active state with daisyUI's own active class", () => {
    const on = renderToStaticMarkup(
      <DesignToggle active={true} disabled={false} onToggle={noop} />,
    );

    expect(on).toContain("btn-active");
  });

  test("turns design mode on", () => {
    const toggles: boolean[] = [];
    const tree = DesignToggle({
      active: false,
      disabled: false,
      onToggle: (next) => toggles.push(next),
    });

    firstButton(tree).onClick?.();

    expect(toggles).toEqual([true]);
  });

  test("turns design mode back off", () => {
    const toggles: boolean[] = [];
    const tree = DesignToggle({
      active: true,
      disabled: false,
      onToggle: (next) => toggles.push(next),
    });

    firstButton(tree).onClick?.();

    expect(toggles).toEqual([false]);
  });

  test("is disabled while a turn is in flight", () => {
    const tree = DesignToggle({
      active: false,
      disabled: true,
      onToggle: noop,
    });

    expect(firstButton(tree).disabled).toBe(true);
  });
});
