/// <reference lib="dom" />
//
// focus-frame.ts — which frame a key press lands in (#2017). press_key types into whatever
// holds keyboard focus, which may be a child frame (an identity provider, or a chat or ad
// widget) rather than the top page; the sign-in code guard needs that frame's site.
//
// focusProbe and isFocusedFrameHost run *inside the browser* via evaluate(), so (as in
// dom-extract.ts) they must stay self-contained: no imports, no module-scope references,
// no named inner functions. Neither reads an input's value.

import type { Frame, Page } from 'playwright';

/**
 * In-page: 'frame' when this document's deepest focused element (through open shadow
 * roots) is an iframe or frame host, so focus continues in a child frame; 'element'
 * otherwise (an input, the body, nothing).
 */
export function focusProbe(): 'frame' | 'element' {
  let active: Element | null = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
  const tag = active ? active.tagName : '';
  return tag === 'IFRAME' || tag === 'FRAME' ? 'frame' : 'element';
}

/** In-page: true when `el` (a frame host) is its document's deepest focused element. */
export function isFocusedFrameHost(el: Element): boolean {
  let active: Element | null = el.ownerDocument.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
  return active === el;
}

/** Deeper than this and the focused frame is not followed (the caller fails closed). */
const MAX_FRAME_DEPTH = 10;

/**
 * The frame whose document a key press lands in: document.activeElement followed down from
 * the main frame through focused frame hosts. Null when that cannot be told (a probe
 * answered something unexpected, no child frame owns the focused host, or the nesting is
 * deeper than MAX_FRAME_DEPTH); throws when a probe throws. Callers fail closed on both.
 */
export async function focusedFrame(page: Page): Promise<Frame | null> {
  let frame = page.mainFrame();
  for (let depth = 0; depth <= MAX_FRAME_DEPTH; depth++) {
    const probe: unknown = await frame.evaluate(focusProbe);
    if (probe === 'element') return frame;
    if (probe !== 'frame') return null;
    let next: Frame | null = null;
    for (const child of frame.childFrames()) {
      const host = await child.frameElement();
      try {
        if ((await host.evaluate(isFocusedFrameHost)) === true) {
          next = child;
          break;
        }
      } finally {
        await host.dispose();
      }
    }
    if (!next) return null;
    frame = next;
  }
  return null;
}
