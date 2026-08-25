import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Capability } from "@paco/plugin-kit";
import { ConsentForm, type ConsentFormProps } from "./consent-form";

const noop = () => {};

/**
 * `ConsentDialog` wraps this in a `Dialog`/`Portal`, which Base UI does not
 * render outside a browser — this codebase's test runner has no DOM. The
 * checklist itself lives in `ConsentForm` precisely so it can be rendered
 * here without that wrapper (see that file's docstring, and
 * `AgentEditorForm`'s identical split).
 */
function renderForm(overrides: Partial<ConsentFormProps> = {}) {
  return renderToStaticMarkup(
    <ConsentForm
      grants={[]}
      netDomains={[]}
      onGrantsChange={noop}
      requested={["events:subscribe"]}
      {...overrides}
    />,
  );
}

describe("ConsentForm", () => {
  test("lists every requested capability", () => {
    const requested: Capability[] = [
      "events:subscribe",
      "messages:post",
      "tools:register",
      "net:fetch",
      "storage:kv",
      "ui:panel",
      "tasks:create",
    ];

    const html = renderForm({ requested });

    for (const capability of requested) {
      expect(html).toContain(capability);
    }
  });

  test("does not show a capability the plugin never requested", () => {
    const html = renderForm({ requested: ["events:subscribe"] });

    expect(html).not.toContain("net:fetch");
    expect(html).not.toContain("storage:kv");
  });

  test("shows the exact net:fetch domain list from the manifest", () => {
    const html = renderForm({
      netDomains: ["api.linear.app", "hooks.slack.com"],
      requested: ["net:fetch"],
    });

    expect(html).toContain("api.linear.app");
    expect(html).toContain("hooks.slack.com");
  });

  test("says so when net:fetch is requested with no declared domains", () => {
    const html = renderForm({ netDomains: [], requested: ["net:fetch"] });

    expect(html).toContain("none declared");
  });

  test("pre-checks only the capabilities already granted", () => {
    const html = renderForm({
      grants: ["events:subscribe"],
      requested: ["events:subscribe", "messages:post"],
    });

    const inputs = html.match(/<input[^>]*>/g) ?? [];
    const subscribeInput = inputs.find((tag) =>
      tag.includes('value="events:subscribe"'),
    );
    const postInput = inputs.find((tag) =>
      tag.includes('value="messages:post"'),
    );

    expect(subscribeInput).toContain("checked");
    expect(postInput).not.toContain("checked");
  });

  test("states what isolation does and does not provide, without overclaiming", () => {
    const html = renderForm();

    expect(html).toContain("not a container");
    expect(html).toContain("force-kill");
    expect(html.toLowerCase()).not.toContain("fully sandboxed");
    expect(html.toLowerCase()).not.toContain("fully isolated");
  });

  test("does not understate tasks:create's actual scope to an inbound message", () => {
    // handleTasksCreate (lib/plugins/capability-handlers.ts) has no check
    // tying the call to a channel event — a plugin holding the grant can
    // call it from a net:fetch handler or a timer just as well.
    const html = renderForm({ requested: ["tasks:create"] });

    expect(html).not.toContain("from an inbound message");
  });

  test("separates what the plugin can read on disk from what it can write", () => {
    // SECURITY.md's allowlist is asymmetric: the plugin can READ its own
    // directory, Paco's plugin-runtime code and its state directory, but can
    // WRITE only the state directory. A line that merges the two ("read and
    // write only inside...") is wrong in both directions at once — it
    // overstates where writes can land and understates what is readable —
    // so both halves are pinned here rather than one phrase.
    const html = renderForm();

    expect(html).toContain("read its own plugin directory");
    expect(html).toContain("state directory");
    expect(html).toContain("only");
    // Still must not overclaim in the other direction.
    expect(html.toLowerCase()).not.toContain("cannot touch your files");
    expect(html.toLowerCase()).not.toContain("no file access");
    // And must not reintroduce the merged read+write claim.
    expect(html).not.toContain("read and write only inside");
  });

  test("names the channels a plugin verifies itself, and says what that means", () => {
    // Granting channels:ingress to a plugin with a self-verified channel is
    // materially different from granting it to one without: requests to that
    // channel reach the plugin with Paco checking nothing. The consent screen
    // is the only place an operator ever sees that.
    const html = renderForm({
      requested: ["channels:ingress"],
      selfVerifiedChannels: ["events"],
    });

    expect(html).toContain("events");
    expect(html).toContain("verifies itself");
    expect(html).toContain("without Paco checking anything");
  });

  test("says a channel plugin's requests need the secret when none are self-verified", () => {
    const html = renderForm({
      requested: ["channels:ingress"],
      selfVerifiedChannels: [],
    });

    expect(html).toContain("per-plugin secret");
    expect(html).not.toContain("verifies itself");
  });

  test("never promises the secret gates every channel", () => {
    // The old copy asserted channels:ingress was "authenticated with a
    // per-plugin secret" unconditionally, which a self-verified channel makes
    // false. Pinned so it cannot come back as a blanket claim.
    const html = renderForm({
      requested: ["channels:ingress"],
      selfVerifiedChannels: ["events"],
    });

    expect(html).not.toContain("authenticated with a per-plugin secret");
  });

  test("states the Node >= 24 floor the isolation depends on", () => {
    const html = renderForm();

    expect(html).toContain("Node");
    expect(html).toContain("24");
  });
});
