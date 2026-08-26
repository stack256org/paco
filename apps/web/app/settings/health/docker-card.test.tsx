import type { DockerPreflightResult } from "@paco/sandbox";
import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("server-only", () => ({}));

const { DockerCard } = await import("./docker-card");
const { setupFailureMessage } =
  await import("@/lib/sandbox/setup-failure-copy");

/**
 * The point of this card is that an operator gets ONE explanation for a broken
 * Docker, whether they meet it here or in a chat that failed to start.
 *
 * That only holds because `dockerPreflight`'s `state` strings are deliberately
 * identical to `ProvisioningFailureReason`'s, so the card can reuse
 * `setupFailureMessage` rather than writing a second set of words that then
 * drift. Nothing in the type system enforces that the two vocabularies stay
 * aligned — they are declared in different packages — so it is pinned here.
 */

function result(over: Partial<DockerPreflightResult>): DockerPreflightResult {
  return {
    state: "ok",
    usable: true,
    message: "",
    securityOptions: [],
    ...over,
  };
}

/**
 * Renders for real, the way this repo's other component tests do — the copy
 * under test lives inside child components, so an element-tree walk that never
 * invokes them reads as empty and every assertion passes vacuously.
 *
 * `renderToStaticMarkup` HTML-escapes, and the failure copy contains shell
 * commands with `&&`, so the markup is unescaped before comparing rather than
 * asserting on a mangled string.
 */
function render(props: Parameters<typeof DockerCard>[0]): string {
  return renderToStaticMarkup(<DockerCard {...props} />)
    .replaceAll("&amp;", "&")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

const FAILURES = [
  "docker-not-running",
  "docker-permission",
  "docker-rootless",
] as const;

describe("DockerCard", () => {
  test("a healthy daemon reports plainly, with no alert", () => {
    const text = render({
      docker: { status: "ok", data: result({ serverVersion: "29.1.3" }) },
    });

    expect(text).toContain("can run chats");
    expect(text).toContain("29.1.3");
    // No "cannot start" scare text on a working host.
    expect(text).not.toContain("Chats cannot start");
  });

  for (const state of FAILURES) {
    test(`"${state}" shows the same words a failed chat shows`, () => {
      const text = render({
        docker: {
          status: "ok",
          data: result({ state, usable: false, message: "raw log text" }),
        },
      });

      // The seam: identical copy, sourced from one place.
      expect(text).toContain(setupFailureMessage(state));
      // `message` is for logs and must never reach the operator verbatim.
      expect(text).not.toContain("raw log text");
    });
  }

  test("an unreadable metric says so, rather than implying Docker is broken", () => {
    const text = render({
      docker: { status: "unavailable", error: "timed out" },
    });

    expect(text).toContain("could not be checked");
    // "We don't know" must not read as "it is broken".
    expect(text).not.toContain("Chats cannot start");
  });
});
