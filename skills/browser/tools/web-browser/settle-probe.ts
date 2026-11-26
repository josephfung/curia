/// <reference lib="dom" />
//
// settle-probe.ts — the in-page half of the post-navigation settle check (#2244). Runs
// *inside the browser* via frame.evaluate(), so it needs the DOM lib, scoped to this file
// the same way dom-extract.ts scopes it.
//
// The exported function must stay self-contained: no imports, no module-scope value
// references, and no NAMED inner functions (prod's keepNames transpile wraps them in a
// module-scope __name helper the page doesn't have; see dom-extract.ts). Anonymous arrow
// callbacks are fine. settle-probe.test.ts guards this.

/** What one frame shows the reader. Counts, not content: the settle loop only needs to
 *  know whether the page has anything meaningful on it yet. */
export interface FrameProbe {
  /** Characters of visible body text, whitespace collapsed. */
  textChars: number;
  /** Visible buttons and form fields that carry a real accessible name. */
  labelledControls: number;
  /** Visible fields a sign-in form asks for: password, email, username, one-time code. */
  credentialFields: number;
}

/**
 * Measure how much meaningful content this frame shows. "Meaningful" is deliberately
 * narrow (#2244 point 6): visible body text, and buttons or form fields with a real name.
 * Links, images and unnamed controls don't count, and a control's name never comes from
 * textContent: Air Canada's blank post-consent page held one SVG logo link whose
 * textContent was CSS (`.st1{fill:#2e2a25}`), which a textContent-based name reads as a
 * label. innerText skips the SVG <style>, so it reads as blank, which it is.
 */
export function probeFrameContent(): FrameProbe {
  const body = document.body;
  if (!body) return { textChars: 0, labelledControls: 0, credentialFields: 0 };

  const textChars = (body.innerText ?? '').replace(/\s+/g, ' ').trim().length;

  const controls = Array.from(document.querySelectorAll(
    'button, input:not([type="hidden"]), select, textarea, [role="button"], [role="textbox"], [role="combobox"], [contenteditable="true"]',
  ));
  let labelledControls = 0;
  let credentialFields = 0;
  controls.forEach((el) => {
    const html = el as HTMLElement;
    // checkVisibility (Chrome 105+) catches display:none, visibility:hidden and opacity 0
    // up the ancestor chain. Fall back to the element's own computed style elsewhere.
    const visible = typeof html.checkVisibility === 'function'
      ? html.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      : (() => {
        const style = getComputedStyle(html);
        return style.display !== 'none' && style.visibility !== 'hidden';
      })();
    if (!visible) return;

    const input = el instanceof HTMLInputElement ? el : null;
    const type = (input?.type ?? '').toLowerCase();
    const labelText = (
      (el.getAttribute('aria-label') ?? '') + ' ' +
      (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
        .map((id) => (document.getElementById(id) as HTMLElement | null)?.innerText ?? '').join(' ') + ' ' +
      Array.from((el as HTMLInputElement).labels ?? []).map((l) => l.innerText).join(' ') + ' ' +
      // A button's visible text. innerText, never textContent (see above).
      (input || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement ? '' : html.innerText) + ' ' +
      (el.getAttribute('placeholder') ?? '') + ' ' +
      (el.getAttribute('title') ?? '') + ' ' +
      (type === 'submit' || type === 'button' || type === 'reset' ? (input?.value ?? '') : '') + ' ' +
      Array.from(el.querySelectorAll('img[alt]')).map((img) => img.getAttribute('alt') ?? '').join(' ')
    ).replace(/\s+/g, ' ').trim();
    if (labelText.length > 0) labelledControls++;

    if (input) {
      const autocomplete = (input.getAttribute('autocomplete') ?? '').toLowerCase();
      const hints = `${input.name} ${input.id} ${labelText}`;
      if (
        type === 'password' || type === 'email' ||
        /\b(username|current-password|new-password|one-time-code|email)\b/.test(autocomplete) ||
        ((type === 'text' || type === 'tel' || type === 'number' || type === '') &&
          /user|login|e-?mail|account|member|passcode|otp|verification|code/i.test(hints))
      ) {
        credentialFields++;
      }
    }
  });

  return { textChars, labelledControls, credentialFields };
}
