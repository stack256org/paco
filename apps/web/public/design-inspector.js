/**
 * Paco's design-candidate click inspector.
 *
 * Injected ONLY into design-candidate previews — never an ordinary chat
 * preview — via nginx `sub_filter` (see `lib/preview/nginx-config.ts`'s
 * `DESIGN_INSPECTOR_PATH` and `isDesignCandidate`), which appends
 * `<script src="/__paco/design-inspector.js"></script>` right before
 * `</body>` on every HTML response from a candidate's dev server. That
 * injection point is also why this has to be a plain, dependency-free
 * script rather than a bundled module: it runs inside the CANDIDATE's own
 * page, on the candidate's own origin, with none of Paco's own build
 * tooling or npm dependencies anywhere nearby — an `import` here would
 * simply fail to resolve.
 *
 * Protocol with the parent frame (the chat's preview pane), both directions
 * over `postMessage`, and both pinned to Paco's own origin — never `"*"`:
 *   - parent -> this script: `{ type: "paco-inspect-arm" }` arms hover
 *     highlighting and click interception. Accepted only when
 *     `event.origin` is exactly Paco's app origin; anything else is
 *     ignored, since arming from an untrusted embedder would let it start
 *     intercepting every click on this page.
 *   - this script -> parent: `{ type: "paco-inspect-click", selector, text,
 *     rect }` on every armed click, after `preventDefault()`'d it — a click
 *     while armed annotates the element, it never navigates or submits.
 *     Posted with Paco's app origin as the exact `targetOrigin`, so a
 *     clicked element's selector and text never reach any other frame that
 *     might have this preview embedded.
 *
 * Paco's app origin comes from the `data-paco-origin` attribute on this
 * script's own `<script>` tag — `previewServerBlock`'s `sub_filter`
 * (`lib/preview/nginx-config.ts`) writes it in when it injects the tag, so
 * this script never has to guess or hard-code it. Read via
 * `document.currentScript`, which is only valid synchronously while a
 * classic (non-async, non-module) script is first executing — exactly the
 * IIFE this whole file is — so it is captured as the very first thing this
 * script does.
 *
 * The selector-building logic below (between the PACO_SELECTOR_LOGIC
 * markers) is a hand-kept copy of `apps/web/lib/design/selector.ts`'s
 * `buildSelector` and its helpers — that module exists so the logic itself
 * is unit-testable, since this file cannot import it. Keep the two in sync;
 * `apps/web/lib/design/selector.build-check.test.ts` fails the build the
 * moment they drift (compared with types and whitespace stripped, since
 * this copy has neither).
 */
(() => {
  // Captured immediately: `document.currentScript` is `null` outside a
  // classic script's own synchronous, top-level execution, so this has to
  // happen before anything else runs, not lazily inside a handler.
  const scriptEl = document.currentScript;
  const PACO_ORIGIN = scriptEl?.dataset?.pacoOrigin || "";

  let armed = false;
  let hovered = null;

  const HOVER_OUTLINE_STYLE_ID = "__paco-inspector-style";
  const HOVER_CLASS = "__paco-inspector-hover";

  function ensureHoverStyle() {
    if (document.querySelector(`#${HOVER_OUTLINE_STYLE_ID}`)) {
      return;
    }
    const style = document.createElement("style");
    style.id = HOVER_OUTLINE_STYLE_ID;
    style.textContent =
      "." +
      HOVER_CLASS +
      " { outline: 2px solid #6366f1 !important; outline-offset: -1px !important; cursor: crosshair !important; }";
    document.head.appendChild(style);
  }

  function clearHover() {
    if (hovered) {
      hovered.classList.remove(HOVER_CLASS);
      hovered = null;
    }
  }

  function textPreview(el) {
    // innerText, not textContent: it reflects what a person actually sees
    // rendered — collapsed whitespace, `display: none` subtrees excluded —
    // which is what an annotation on a *clicked* (therefore visible)
    // element should describe. textContent would include hidden text a
    // click could never have landed on.
    // oxlint-disable-next-line unicorn/prefer-dom-node-text-content -- see above
    const text = (el.innerText || el.textContent || "").trim();
    return text.length > 80 ? text.slice(0, 80) : text;
  }

  function rectFor(el) {
    const rect = el.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      top: rect.top,
      left: rect.left,
    };
  }

  // === PACO_SELECTOR_LOGIC_START ===
  // Byte-for-byte identical to selector.ts's copy of this block, modulo
  // type annotations and `export` — see this file's header comment.
  // No object literals or ternaries anywhere in this block: the drift-check
  // normalizer (`selector.build-check.test.ts`) strips `: Identifier` type
  // annotations with a plain regex, which cannot tell an object literal's
  // `key: value` or a ternary's `cond ? a : b` apart from a real type
  // annotation. Keep this block to declarations, if/while, and plain
  // expressions so that regex stays safe.
  const MAX_SELECTOR_DEPTH = 6;

  function cssEscapeIdent(value) {
    const length = value.length;
    let result = "";
    let index = -1;
    const firstCodeUnit = value.charCodeAt(0);

    while (++index < length) {
      const codeUnit = value.charCodeAt(index);
      if (codeUnit === 0x00) {
        result += "�";
        continue;
      }
      if (
        (codeUnit >= 0x01 && codeUnit <= 0x1f) ||
        codeUnit === 0x7f ||
        (index === 0 && codeUnit >= 0x30 && codeUnit <= 0x39) ||
        (index === 1 &&
          codeUnit >= 0x30 &&
          codeUnit <= 0x39 &&
          firstCodeUnit === 0x2d)
      ) {
        result += `\\${codeUnit.toString(16)} `;
        continue;
      }
      if (index === 0 && length === 1 && codeUnit === 0x2d) {
        result += `\\${value.charAt(index)}`;
        continue;
      }
      if (
        codeUnit >= 0x80 ||
        codeUnit === 0x2d ||
        codeUnit === 0x5f ||
        (codeUnit >= 0x30 && codeUnit <= 0x39) ||
        (codeUnit >= 0x41 && codeUnit <= 0x5a) ||
        (codeUnit >= 0x61 && codeUnit <= 0x7a)
      ) {
        result += value.charAt(index);
        continue;
      }
      result += `\\${value.charAt(index)}`;
    }
    return result;
  }

  function escapeForSelector(value) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(value);
    }
    return cssEscapeIdent(value);
  }

  function nthOfType(el) {
    let n = 1;
    let sib = el.previousElementSibling;
    while (sib) {
      if (sib.tagName === el.tagName) {
        n++;
      }
      sib = sib.previousElementSibling;
    }
    return n;
  }

  function segmentFor(el) {
    if (el.id) {
      return `#${escapeForSelector(el.id)}`;
    }
    const testId = el.dataset.testid;
    if (testId) {
      return `[data-testid="${testId.replace(/"/g, '\\"')}"]`;
    }
    return `${el.tagName.toLowerCase()}:nth-of-type(${nthOfType(el)})`;
  }

  function buildSelector(target) {
    const segments = [];
    let el = target;
    let depth = 0;

    while (el && depth < MAX_SELECTOR_DEPTH) {
      const segment = segmentFor(el);
      segments.unshift(segment);
      depth++;

      if (segment.startsWith("#") || segment.startsWith("[data-testid")) {
        break;
      }

      el = el.parentElement;
    }

    return segments.join(" > ");
  }
  // === PACO_SELECTOR_LOGIC_END ===

  function onPointerOver(event) {
    if (!armed) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element) || target === hovered) {
      return;
    }
    clearHover();
    hovered = target;
    hovered.classList.add(HOVER_CLASS);
  }

  function onPointerOut(event) {
    if (!armed) {
      return;
    }
    if (event.target === hovered) {
      clearHover();
    }
  }

  function onClick(event) {
    if (!armed) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    // `PACO_ORIGIN`, never `"*"`: an exact targetOrigin is what stops a
    // clicked element's selector and text from reaching any frame other
    // than Paco's own UI, even if something else has this preview embedded
    // (see this file's header comment). An empty `PACO_ORIGIN` (the script
    // tag's `data-paco-origin` was missing) makes `postMessage` throw on a
    // malformed targetOrigin rather than silently broadcast — arming can
    // never happen in that case anyway (see `onMessage` below), so this
    // line is unreachable then in practice.
    window.parent.postMessage(
      {
        type: "paco-inspect-click",
        selector: buildSelector(target),
        text: textPreview(target),
        rect: rectFor(target),
      },
      PACO_ORIGIN,
    );
  }

  function onMessage(event) {
    // Only Paco's own app origin may arm this script. Without this check,
    // any page able to embed a candidate preview in an iframe could send
    // `paco-inspect-arm` itself and start intercepting every click on it.
    if (!PACO_ORIGIN || event.origin !== PACO_ORIGIN) {
      return;
    }
    const data = event.data;
    if (!data || typeof data !== "object") {
      return;
    }
    if (data.type === "paco-inspect-arm") {
      armed = true;
      ensureHoverStyle();
    }
  }

  window.addEventListener("message", onMessage);
  document.addEventListener("mouseover", onPointerOver, true);
  document.addEventListener("mouseout", onPointerOut, true);
  // Capture phase, and ahead of every other listener a candidate's own
  // freshly-generated app might attach — an armed click must never reach
  // the candidate's own navigation/form handling.
  document.addEventListener("click", onClick, true);
})();
