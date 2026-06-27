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
 * DOM-extraction routine run *inside the browser* for one frame. Returns cleaned,
 * LLM-friendly text (rendered DOM, not raw HTML) plus a labelled list of form fields.
 * Defined once and passed to each frame's evaluate() so main-frame and iframe content
 * are extracted identically.
 */
export function extractFrameContent(): string {
  // Clone the body before stripping noise elements — mutating the live DOM would
  // destroy scripts/styles/etc. for subsequent actions in the same session.
  const root = document.body?.cloneNode(true) as HTMLBodyElement | null;
  if (!root) return '';

  // Remove noise elements from the clone — we want content, not chrome. (iframe
  // elements are stripped here too: their *contents* are extracted separately per
  // frame, so leaving the empty <iframe> shell in would add nothing.)
  const noiseSelectors = ['script', 'style', 'noscript', 'svg', 'iframe', 'template'];
  for (const sel of noiseSelectors) {
    root.querySelectorAll(sel).forEach(el => el.remove());
  }

  // Extract form fields with their labels — the LLM needs to know what
  // fields exist and what they're called to fill them correctly.
  // Query the live DOM for form fields so we can look up labels by ID.
  const formFields: string[] = [];
  const seenGroups = new Set<string>();

  // Group radios/checkboxes by fieldset legend or aria-labelledby so quiz widgets
  // (e.g. 16personalities) expose "Question N: …" plus clickable option labels.
  document.querySelectorAll('fieldset').forEach(fieldset => {
    const legend = fieldset.querySelector('legend')?.textContent?.trim();
    if (!legend) return;
    const key = legend.slice(0, 120);
    if (seenGroups.has(key)) return;
    seenGroups.add(key);
    const options: string[] = [];
    fieldset.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach(el => {
      const input = el as HTMLInputElement;
      const opt = input.getAttribute('aria-label')
        ?? input.getAttribute('value')
        ?? input.id;
      if (opt) options.push(opt);
    });
    if (options.length > 0) {
      formFields.push(`[question: ${legend}]`);
      options.forEach(o => formFields.push(`  (option: ${o})`));
    }
  });

  document.querySelectorAll('input, select, textarea').forEach(el => {
    const input = el as HTMLInputElement;
    if (input.type === 'hidden') return;
    const id = input.id;
    const labelEl = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    const label = input.getAttribute('aria-label')
      ?? labelEl?.textContent?.trim()
      ?? input.getAttribute('placeholder')
      ?? input.getAttribute('name')
      ?? input.type;
    const entry = `[${input.type ?? 'field'}: ${label}]`;
    // Skip radios already covered by a fieldset group above.
    if ((input.type === 'radio' || input.type === 'checkbox') && seenGroups.size > 0) return;
    formFields.push(entry);
  });

  // Prefer main/article content over chrome when the page has a clear content root.
  const contentRoot = (document.querySelector('main, [role="main"], article, .sp-card')
    ?? root) as HTMLElement;
  const bodyText = (contentRoot.innerText ?? contentRoot.textContent ?? root.innerText ?? '').trim();
  const formSummary = formFields.length > 0
    ? '\n\n--- Form fields ---\n' + formFields.join('\n')
    : '';

  return bodyText + formSummary;
}
