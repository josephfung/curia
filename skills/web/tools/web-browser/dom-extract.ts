/// <reference lib="dom" />
//
// dom-extract.ts — DOM-extraction routine that runs *inside the browser* via
// Playwright's frame.evaluate(). It uses browser globals (document, CSS,
// HTMLInputElement, …) that the project's base tsconfig `lib` deliberately omits,
// because server code must never see them. The triple-slash directive above scopes
// the DOM lib to THIS file only — rather than adding "dom" to compilerOptions.lib,
// which would expose DOM globals to every skill and mask real errors elsewhere.
//
// The exported function must stay self-contained (no module-scope references, no
// imports, no closures): Playwright serializes it to source and runs it in the page,
// where this module's scope does not exist. Keep it that way.

/**
 * Options passed in from the handler. Type-only (erased at compile), so referencing it
 * here does not violate the "no module-scope value references" rule for a serialized fn.
 */
interface ExtractOpts {
  // This frame's index within page.frames() AT THIS READ. Combined with the epoch it forms a
  // per-document ref namespace so refs from different frames don't collide. NB: page.frames()
  // ordering is not stable across reads (removing a preceding sibling shifts everyone down), so
  // a document PINS this value at adoption (see __curiaRefFrame__ below) and reuses the pinned
  // one when minting — re-deriving it each read would let two same-epoch frames converge on the
  // same ref after a reindex. Passed in (rather than threaded back) to keep the frame mocks in
  // handler.test.ts returning a plain string.
  frameIndex: number;
  // Max interactables to tag + list before truncating. Passed in because this function
  // runs in-browser and cannot import the handler's module constant.
  maxRefs: number;
  // Monotonic epoch seed from the handler (a process-global counter that NEVER resets, even
  // across navigations). A fresh document (new window) adopts it as THIS document's epoch and
  // stamps it into every ref; a document that already carries an epoch keeps its own. This is
  // what makes refs unique ACROSS documents — a ref minted on a page that has since navigated
  // away carries an older epoch and matches nothing on the new page (fail closed) — while
  // staying stable across same-document re-extractions. window resets on navigation, so the
  // per-frame element counter alone would recycle e-numbers onto a new page's elements; the
  // epoch prevents that recycled number from silently addressing the wrong element.
  epochSeed: number;
}

/**
 * DOM-extraction routine run *inside the browser* for one frame. Returns cleaned,
 * LLM-friendly text (rendered DOM, not raw HTML) followed by a list of interactable
 * elements, each tagged with a stable `data-curia-ref` the agent can use as an exact
 * click/type selector. Assigning refs here (rather than resolving by fuzzy label) is
 * what lets the agent disambiguate duplicate labels — e.g. a survey's repeated "Agree"
 * radios, each of which becomes a distinct ref tied to its own question group.
 *
 * Must stay self-contained (no imports, no module-scope *value* references, no closures):
 * Playwright serializes it to source and runs it in the page. Helpers below are declared
 * inside the function so they serialize with it.
 */
export function extractFrameContent(opts: ExtractOpts): string {
  const { frameIndex, maxRefs, epochSeed } = opts;

  // --- bodyText: clone the body, strip noise, prefer the main content root. (unchanged) ---
  const root = document.body?.cloneNode(true) as HTMLBodyElement | null;
  if (!root) return '';
  const noiseSelectors = ['script', 'style', 'noscript', 'svg', 'iframe', 'template'];
  for (const sel of noiseSelectors) {
    root.querySelectorAll(sel).forEach(el => el.remove());
  }
  const contentRoot = (document.querySelector('main, [role="main"], article, .sp-card')
    ?? root) as HTMLElement;
  const bodyText = (contentRoot.innerText ?? contentRoot.textContent ?? root.innerText ?? '').trim();

  // --- Interactable elements: tag each with a stable ref on the LIVE DOM ---
  // Refs are STABLE across re-extractions of the same document, yet distinct ACROSS documents.
  // Two forces are in tension:
  //   * Every browser action ends by re-reading the page, so renumbering on each extraction
  //     (the first version of this feature) invalidated a ref within one action of handing it
  //     to the agent — reads-then-multiple-acts hung until timeout. => refs must persist.
  //   * window (and any counter on it) resets on navigation, so a per-document counter alone
  //     recycles e-numbers onto the NEXT page's elements; a stale ref would then resolve to
  //     exactly one live (wrong) element and be clicked. => numbering must not repeat per page.
  // Resolution: PRESERVE an element's existing ref, mint new ones from a per-document `seq`,
  // and stamp each ref with an `epoch` AND a `frame` scope this document adopts once. The epoch
  // comes from the handler's monotonic `epochSeed` (never resets across navigations); a fresh
  // window has no epoch yet so it adopts the current seed and pins the current frameIndex, while
  // a re-extracted document keeps both — so same-document refs stay valid and cross-document
  // refs never collide. Pinning the frame scope matters because page.frames() order shifts when
  // a preceding sibling frame is removed: without pinning, a frame sliding into a vacated index
  // would mint refs colliding with another same-epoch frame's retained refs. (epoch, frame) is
  // therefore a stable per-document identity — distinct frames in one read have distinct indices,
  // and later reads take strictly greater epochs. A removed element's ref matches nothing (fail
  // closed); no live element inherits an old ref. NB: these on-window values are page-reachable
  // and a hostile page could tamper with them, but that is not a wrong-element hazard — the
  // handler's resolver ignores them and resolves ONLY when exactly one live element carries the
  // ref, so any recycling fails closed.
  const refState = window as unknown as {
    __curiaRefEpoch__?: number; __curiaRefFrame__?: number; __curiaRefSeq__?: number;
  };
  if (typeof refState.__curiaRefEpoch__ !== 'number') {
    refState.__curiaRefEpoch__ = epochSeed;    // fresh document → take this snapshot's epoch
    refState.__curiaRefFrame__ = frameIndex;   // …and pin the frame scope at adoption
    refState.__curiaRefSeq__ = 0;
  }
  const epoch = refState.__curiaRefEpoch__;
  const frameScope = refState.__curiaRefFrame__ ?? frameIndex;

  const INTERACTABLE_SELECTOR = [
    'button', 'a[href]', 'input:not([type="hidden"])', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="tab"]', '[role="menuitem"]', '[role="option"]', '[role="combobox"]',
    '[role="switch"]',
  ].join(',');

  // Role and accessible-name are computed INLINE below, deliberately NOT via named helper
  // functions. Playwright serializes this function into the browser page via
  // frame.evaluate(); the tsx/esbuild `keepNames` transform wraps any named inner function
  // in a module-scope `__name(...)` helper that does NOT exist in the page, so a named inner
  // function throws `ReferenceError: __name is not defined` on every frame (this took down
  // all browser page-reads in prod once). Keep this function free of named inner functions;
  // the keepNames regression test in dom-extract.test.ts guards it. Anonymous forEach/arrow
  // callbacks are fine — keepNames only wraps functions bound to a name.

  const interactables = Array.from(document.querySelectorAll(INTERACTABLE_SELECTOR));
  const shown = Math.min(interactables.length, maxRefs);
  const refLines: string[] = [];
  for (let i = 0; i < shown; i++) {
    const el = interactables[i]!;
    // Reuse this element's ref if it already has one (stable across re-extractions); only
    // mint a fresh id for an element seen for the first time. The (epoch, frameScope) pair
    // scopes the id to this document; each frame's window has its own seq starting at 1.
    let ref = el.getAttribute('data-curia-ref');
    if (!ref) {
      refState.__curiaRefSeq__ = (refState.__curiaRefSeq__ ?? 0) + 1;
      ref = `g${epoch}f${frameScope}e${refState.__curiaRefSeq__}`;
      el.setAttribute('data-curia-ref', ref);
    }

    // ARIA role for display: explicit role attribute wins, else derive from the tag.
    let role = el.getAttribute('role') ?? '';
    if (!role) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') role = 'link';
      else if (tag === 'button') role = 'button';
      else if (tag === 'select') role = 'combobox';
      else if (tag === 'textarea') role = 'textbox';
      else if (tag === 'input') {
        const t = (el.getAttribute('type') ?? 'text').toLowerCase();
        role = t === 'radio' ? 'radio'
          : t === 'checkbox' ? 'checkbox'
          : (t === 'button' || t === 'submit' || t === 'reset') ? 'button'
          : 'textbox';
      } else {
        role = 'element';
      }
    }

    // Accessible name, same precedence as before: aria-label, <label for>, visible text,
    // then placeholder/value/name/title. Empty is acceptable — ref + role still address it.
    let name = '';
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) {
      name = aria.trim();
    } else {
      const id = (el as HTMLElement).id;
      const lbl = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      const lblText = lbl?.textContent?.trim();
      const text = (el.textContent ?? '').trim();
      if (lblText) name = lblText;
      else if (text) name = text;
      else name = el.getAttribute('placeholder')
        ?? el.getAttribute('value')
        ?? el.getAttribute('name')
        ?? el.getAttribute('title')
        ?? '';
    }
    name = name.replace(/\s+/g, ' ').slice(0, 100);

    const legend = el.closest('fieldset')?.querySelector('legend')?.textContent?.trim();
    const group = legend ? ` (group: "${legend.slice(0, 120)}")` : '';
    refLines.push(`[${ref}] ${role} "${name}"${group}`);
  }
  const overflow = interactables.length > maxRefs
    ? `\n(${interactables.length - maxRefs} more interactable elements not shown; scroll or refine)`
    : '';
  // NOTE: this '\n\n--- Interactable elements ---\n' header is load-bearing downstream:
  // getCleanedContent in handler.ts splits on it (as REF_SECTION_SENTINEL) to budget prose
  // and the ref list separately. If you change the text here, change it there too — a
  // mismatch silently folds the whole ref list back into the body budget (no test signal).
  const refSummary = refLines.length > 0
    ? '\n\n--- Interactable elements ---\n' + refLines.join('\n') + overflow
    : '';

  return bodyText + refSummary;
}
