import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PreviewVisibility } from "@/lib/preview/visibility";
import { PreviewShareView, PUBLIC_WARNING } from "./preview-share-view";
import type { PreviewShareStatus } from "./use-preview-share";

const noop = () => {};

function render(
  state: PreviewShareStatus,
  overrides: Partial<{
    copied: boolean;
    updating: boolean;
    onCopy: (text: string) => void;
    onVisibilityChange: (next: PreviewVisibility) => void;
  }> = {},
) {
  return renderToStaticMarkup(
    <PreviewShareView
      copied={overrides.copied ?? false}
      onCopy={overrides.onCopy ?? noop}
      onVisibilityChange={overrides.onVisibilityChange ?? noop}
      state={state}
      updating={overrides.updating ?? false}
    />,
  );
}

describe("PreviewShareView", () => {
  test("shows a loading line while the share state loads", () => {
    const html = render({ status: "loading" });

    expect(html).toContain("Loading preview link");
    expect(html).not.toContain("Private");
    expect(html).not.toContain("Public");
  });

  test("reports a load failure without showing a stale URL", () => {
    const html = render({ status: "error" });

    expect(html).toContain("couldn&#x27;t load");
    expect(html).not.toContain("Private");
    expect(html).not.toContain("Public");
  });

  test("explains an unconfigured preview domain and links to Settings, not a dead URL", () => {
    const html = render({
      status: "ready",
      hostname: null,
      tlsEnabled: false,
      visibility: "private",
    });

    expect(html).toContain("No preview domain is configured");
    expect(html).toContain('href="/settings/admin"');
    expect(html).not.toContain("previews.example.com");
    expect(html).not.toContain("Private —");
    expect(html).not.toContain("Public");
  });

  test("states private is the default, over http when TLS is off", () => {
    const html = render({
      status: "ready",
      hostname: "chat-abc.previews.example.com",
      tlsEnabled: false,
      visibility: "private",
    });

    expect(html).toContain("http://chat-abc.previews.example.com");
    expect(html).not.toContain("https://chat-abc.previews.example.com");
    expect(html).toContain(
      "Private (the default) — only you can open this link",
    );
  });

  test("qualifies the private link: it can serve a sibling chat, and raw ports bypass it entirely", () => {
    const html = render({
      status: "ready",
      hostname: "chat-abc.previews.example.com",
      tlsEnabled: false,
      visibility: "private",
    });

    expect(html).toContain("port 3000");
    expect(html).toContain("sibling chat");
    expect(html).toContain("5173/4321/8000");
    expect(html).toContain("unauthenticated");
  });

  test("uses https once TLS is on", () => {
    const html = render({
      status: "ready",
      hostname: "chat-abc.previews.example.com",
      tlsEnabled: true,
      visibility: "private",
    });

    expect(html).toContain("https://chat-abc.previews.example.com");
  });

  test("states the public warning plainly, with no sign-in and the credentials/data risk named", () => {
    const html = render({
      status: "ready",
      hostname: "chat-abc.previews.example.com",
      tlsEnabled: true,
      visibility: "private",
    });

    // The confirmation dialog is always in the tree (opened imperatively via
    // showModal), so the warning text is present even before the Public
    // button is clicked. `react-dom/server` HTML-escapes the apostrophe in
    // "you're", so the comparison has to match what actually renders.
    expect(html).toContain(PUBLIC_WARNING.replace(/'/g, "&#x27;"));
    expect(PUBLIC_WARNING).toContain("no sign-in required");
    expect(PUBLIC_WARNING).toContain("Anyone with this link");
    expect(PUBLIC_WARNING.toLowerCase()).toContain("credentials");
    expect(PUBLIC_WARNING.toLowerCase()).toContain("real data");
  });

  test("shows the public state distinctly once a preview is public", () => {
    const html = render({
      status: "ready",
      hostname: "chat-abc.previews.example.com",
      tlsEnabled: true,
      visibility: "public",
    });

    expect(html).toContain("Anyone with the link can open this — no sign-in.");
    expect(html).toContain("btn-warning");
  });

  test("copy button announces success once copied", () => {
    const html = render(
      {
        status: "ready",
        hostname: "chat-abc.previews.example.com",
        tlsEnabled: true,
        visibility: "private",
      },
      { copied: true },
    );

    expect(html).toContain('aria-label="Copied"');
  });
});
