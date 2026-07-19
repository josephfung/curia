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
  const { frameIndex, maxRefs } = opts;

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

  // ARIA role for display: explicit role attribute wins, else derive from the tag.
  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (t === 'radio') return 'radio';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
      return 'textbox';
    }
    return 'element';
  };

  // Accessible name, same precedence the old form-fields list used, extended to buttons/
  // links (their visible text). Empty is acceptable — ref + role still address the element.
  const nameOf = (el: Element): string => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const id = (el as HTMLElement).id;
    if (id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      const lblText = lbl?.textContent?.trim();
      if (lblText) return lblText;
    }
    const text = (el.textContent ?? '').trim();
    if (text) return text;
    return el.getAttribute('placeholder')
      ?? el.getAttribute('value')
      ?? el.getAttribute('name')
      ?? el.getAttribute('title')
      ?? '';
  };

  const interactables = Array.from(document.querySelectorAll(INTERACTABLE_SELECTOR));
  const shown = Math.min(interactables.length, maxRefs);
  const refLines: string[] = [];
  for (let i = 0; i < shown; i++) {
    const el = interactables[i]!;
    const ref = `f${frameIndex}e${i + 1}`;
    el.setAttribute('data-curia-ref', ref);
    const name = nameOf(el).replace(/\s+/g, ' ').slice(0, 100);
    const legend = el.closest('fieldset')?.querySelector('legend')?.textContent?.trim();
    const group = legend ? ` (group: "${legend.slice(0, 120)}")` : '';
    refLines.push(`[${ref}] ${roleOf(el)} "${name}"${group}`);
  }
  const overflow = interactables.length > maxRefs
    ? `\n(${interactables.length - maxRefs} more interactable elements not shown; scroll or refine)`
    : '';
  const refSummary = refLines.length > 0
    ? '\n\n--- Interactable elements ---\n' + refLines.join('\n') + overflow
    : '';

  return bodyText + refSummary;
}
