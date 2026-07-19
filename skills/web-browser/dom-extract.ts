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
  // Index of this frame within page.frames(); makes refs unique across frames without
  // threading a global counter back to the handler (which would force an object return
  // and break the string-returning frame mocks in handler.test.ts).
  frameIndex: number;
  // Max interactables to tag + list before truncating. Passed in because this function
  // runs in-browser and cannot import the handler's module constant.
  maxRefs: number;
  // Per-extraction generation, stamped into every ref so a ref outlives no snapshot: a ref
  // from an earlier extraction carries an older generation and matches no current attribute.
  generation: number;
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
  const { frameIndex, maxRefs, generation } = opts;

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
  // Clear refs from a prior extraction first, so this snapshot's refs are the only ones
  // present. A ref never outlives the snapshot that issued it: an element removed since
  // the last snapshot leaves no stale ref for the resolver to match.
  document.querySelectorAll('[data-curia-ref]').forEach(el => el.removeAttribute('data-curia-ref'));

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
    const ref = `g${generation}f${frameIndex}e${i + 1}`;
    el.setAttribute('data-curia-ref', ref);

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
