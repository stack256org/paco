import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AccountMenuTrigger,
  resolveAccountDisplayName,
} from "./account-menu-trigger";
import type { Session as AuthSession } from "@/lib/session/types";

/**
 * `AppAccountMenu` wraps this in `useRouter` and a confirm dialog, neither of
 * which renders without a browser — this codebase's test runner has no DOM.
 * The trigger lives in its own file precisely so it can be rendered here
 * without them (see that file's docstring, and `ConsentForm`'s identical
 * split).
 */
function renderTrigger(displayName: string) {
  return renderToStaticMarkup(
    <AccountMenuTrigger
      anchorName="--account-anchor"
      displayName={displayName}
      popoverTarget="account-menu"
    />,
  );
}

/** The `<span>` holding the visible name, as rendered. */
function labelTag(html: string): string {
  const tags = html.match(/<span[^>]*>/g) ?? [];
  const label = tags.find((tag) => tag.includes("truncate"));
  if (!label) {
    throw new Error(`no truncating label span in: ${html}`);
  }
  return label;
}

function user(overrides: Partial<AuthSession["user"]>): AuthSession["user"] {
  return {
    email: undefined,
    id: "u_1",
    username: "",
    ...overrides,
  };
}

describe("resolveAccountDisplayName", () => {
  test("prefers the real name from the users row", () => {
    expect(
      resolveAccountDisplayName(
        user({
          email: "ada@example.com",
          name: "Ada Lovelace",
          username: "ada",
        }),
      ),
    ).toBe("Ada Lovelace");
  });

  test("falls back to the username when there is no name", () => {
    expect(
      resolveAccountDisplayName(
        user({ email: "ada@example.com", username: "ada" }),
      ),
    ).toBe("ada");
  });

  test("falls back to the email's local part when there is no name or username", () => {
    // The domain is the same for everyone on a self-hosted instance, so it
    // costs bar width and says nothing.
    expect(
      resolveAccountDisplayName(user({ email: "ada.lovelace@example.com" })),
    ).toBe("ada.lovelace");
  });

  test("treats whitespace-only fields as absent", () => {
    expect(
      resolveAccountDisplayName(
        user({ email: "ada@example.com", name: "   ", username: "  " }),
      ),
    ).toBe("ada");
  });

  test("never returns an empty label, even with nothing loaded", () => {
    // An unlabelled control is the bug this change exists to fix, so the
    // not-yet-loaded case gets a word rather than a collapsing button.
    expect(resolveAccountDisplayName(undefined)).toBe("Account");
    expect(resolveAccountDisplayName(user({}))).toBe("Account");
  });
});

describe("AccountMenuTrigger", () => {
  test("shows the name next to the avatar", () => {
    const html = renderTrigger("Ada Lovelace");

    expect(html).toContain("Ada Lovelace");
  });

  test("renders the fallback label when there is no name", () => {
    const html = renderTrigger(resolveAccountDisplayName(undefined));

    expect(html).toContain("Account");
  });

  test("keeps the name inside the single button that opens the menu", () => {
    // One control, not a label sitting beside one: the click target has to
    // grow rather than fragment.
    const html = renderTrigger("Ada Lovelace");

    const buttons = html.match(/<button/g) ?? [];
    expect(buttons).toHaveLength(1);
    // React serializes the prop name verbatim; HTML attribute names are
    // case-insensitive, so match it that way.
    expect(html.toLowerCase()).toContain('popovertarget="account-menu"');
    // The name is inside the button element, not after it.
    expect(html.indexOf("Ada Lovelace")).toBeLessThan(
      html.indexOf("</button>"),
    );
  });

  test("a long email cannot push the label past its container", () => {
    const html = renderTrigger("someone.with.a.very.long.address@example.com");

    const label = labelTag(html);
    // `truncate` alone does nothing to a flex item: min-width defaults to
    // auto, so the text sets the button's width instead of being clipped.
    expect(label).toContain("truncate");
    expect(label).toContain("min-w-0");
    // And the button itself is capped, so truncation has something to bite on.
    expect(html).toContain("max-w-40");
  });

  test("hides the label at narrow widths rather than letting it take the bar", () => {
    const label = labelTag(renderTrigger("ada"));

    expect(label).toContain("hidden");
    expect(label).toContain("sm:block");
  });

  test("never lets the avatar shrink", () => {
    const html = renderTrigger("someone.with.a.very.long.address@example.com");

    const avatar = (html.match(/<span[^>]*>/g) ?? []).find((tag) =>
      tag.includes("avatar"),
    );
    expect(avatar).toContain("shrink-0");
  });

  test("keeps one accessible name that contains the visible one", () => {
    // The visible text is what a speech-input user says, so the accessible
    // name has to contain it (WCAG 2.5.3) — and it must not read the name
    // twice, which is what a separate label beside the button would do.
    const html = renderTrigger("Ada Lovelace");

    expect(html).toContain('aria-label="Account menu for Ada Lovelace"');
    expect(html.match(/aria-label=/g) ?? []).toHaveLength(1);
    expect(html.match(/Ada Lovelace/g) ?? []).toHaveLength(2); // label + text
  });
});
