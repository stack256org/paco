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
 * over `postMessage`:
 *   - parent -> this script: `{ type: "paco-inspect-arm" }` arms hover
 *     highlighting and click interception. There is no corresponding
 *     "disarm" message in this version — the pane is expected to swap the
 *     iframe's `src`/reload the candidate to disarm, which drops this
 *     script's state along with everything else.
 *   - this script -> parent: `{ type: "paco-inspect-click", selector, text,
 *     rect }` on every armed click, after `preventDefault()`'d it — a click
 *     while armed annotates the element, it never navigates or submits.
 *
 * The selector-building logic below (between the PACO_SELECTOR_LOGIC
 * markers) is a hand-kept copy of `apps/web/lib/design/selector.ts`'s
 * `buildSelector` and its helpers — that module exists so the logic itself
 * is unit-testable, since this file cannot import it. Keep the two in sync;
 * `apps/web/lib/design/selector.build-check.test.ts` fails the build the
 * moment they drift (compared with types and whitespace stripped, since
 * this copy has neither).
 */
(function () {
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
    const text = (el.textContent || "").trim();
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
  const MAX_SELECTOR_DEPTH = 6;

  function escapeForSelector(value) {
    return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
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

    window.parent.postMessage(
      {
        type: "paco-inspect-click",
        selector: buildSelector(target),
        text: textPreview(target),
        rect: rectFor(target),
      },
      "*",
    );
  }

  function onMessage(event) {
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
