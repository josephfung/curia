// @vitest-environment happy-dom
//
// Unit tests for the in-page DOM extractor. Runs under happy-dom (not the repo's
// default node env) so `document`, querySelectorAll, setAttribute, CSS.escape, etc.
// exist — this function was previously only exercised in a real browser via
// frame.evaluate(), so these are its first direct tests.
import { describe, it, expect, beforeEach } from 'vitest';
import { transformWithEsbuild } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractFrameContent } from './dom-extract.js';

const OPTS = { frameIndex: 0, maxRefs: 200, epochSeed: 1 };

// Refs carry a per-document epoch and a per-document seq, both stored on `window` so they
// survive across frame.evaluate() calls (that is what keeps a ref stable across re-extractions
// of the same document). happy-dom shares one window across a file's tests, so clear both keys
// before each test to simulate a fresh document that will adopt this test's epochSeed.
function resetRefState(): void {
  const w = window as unknown as {
    __curiaRefEpoch__?: number; __curiaRefFrame__?: number; __curiaRefSeq__?: number;
  };
  w.__curiaRefEpoch__ = undefined;
  w.__curiaRefFrame__ = undefined;
  w.__curiaRefSeq__ = undefined;
}

describe('extractFrameContent — interactable refs', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetRefState();
  });

  it('assigns a unique ref to every interactable and lists them', () => {
    document.body.innerHTML = `
      <button>Save</button>
      <a href="/next">Next</a>
      <a href="/next">Next</a>`;
    const out = extractFrameContent(OPTS);
    expect(out).toContain('--- Interactable elements ---');
    expect(out).toContain('[g1f0e1] button "Save"');
    expect(out).toContain('[g1f0e2] link "Next"');
    expect(out).toContain('[g1f0e3] link "Next"');
    // The two identical "Next" links are now distinct, addressable elements.
    expect(document.querySelector('[data-curia-ref="g1f0e2"]')!.getAttribute('href')).toBe('/next');
  });

  it('disambiguates duplicate radio labels across question groups (the survey case)', () => {
    document.body.innerHTML = `
      <fieldset><legend>Q1 I make friends easily</legend>
        <input type="radio" name="q1" aria-label="Agree">
        <input type="radio" name="q1" aria-label="Disagree">
      </fieldset>
      <fieldset><legend>Q2 I enjoy crowds</legend>
        <input type="radio" name="q2" aria-label="Agree">
        <input type="radio" name="q2" aria-label="Disagree">
      </fieldset>`;
    const out = extractFrameContent(OPTS);
    expect(out).toContain('[g1f0e1] radio "Agree" (group: "Q1 I make friends easily")');
    expect(out).toContain('[g1f0e3] radio "Agree" (group: "Q2 I enjoy crowds")');
    // The ref maps to the exact input for Q2 — the element pickBestLocator could never reach.
    const q2Agree = document.querySelector('[data-curia-ref="g1f0e3"]') as HTMLInputElement;
    expect(q2Agree.getAttribute('name')).toBe('q2');
  });

  it('caps the list at maxRefs and reports the remainder', () => {
    document.body.innerHTML =
      Array.from({ length: 5 }, (_, i) => `<button>B${i}</button>`).join('');
    const out = extractFrameContent({ frameIndex: 0, maxRefs: 2, epochSeed: 1 });
    expect(out).toContain('[g1f0e1] button "B0"');
    expect(out).toContain('[g1f0e2] button "B1"');
    expect(out).not.toContain('[g1f0e3]');
    expect(out).toContain('(3 more interactable elements not shown');
    // Only the capped elements receive refs.
    expect(document.querySelectorAll('[data-curia-ref]').length).toBe(2);
  });

  it('drops a removed element\'s ref (fail closed) while survivors keep theirs', () => {
    document.body.innerHTML = '<button>One</button><button>Two</button>';
    extractFrameContent(OPTS);            // One=g1f0e1, Two=g1f0e2
    document.querySelectorAll('button')[1]!.remove();  // Two gone before next snapshot
    extractFrameContent(OPTS);
    // Two's element is gone, so its ref matches nothing — a stale action fails closed.
    expect(document.querySelector('[data-curia-ref="g1f0e2"]')).toBeNull();
    // One survives and KEEPS its original ref, so a ref handed out earlier is still valid.
    expect(document.querySelector('[data-curia-ref="g1f0e1"]')!.textContent).toBe('One');
    expect(document.querySelectorAll('[data-curia-ref]').length).toBe(1);
  });

  it('emits no Interactable section when the page has none', () => {
    document.body.innerHTML = '<p>Just some prose, nothing to click.</p>';
    const out = extractFrameContent(OPTS);
    expect(out).not.toContain('--- Interactable elements ---');
    expect(out).toContain('Just some prose');
  });

  it('scopes the ref prefix to the frame index (cross-frame uniqueness)', () => {
    document.body.innerHTML = '<button>Only</button>';
    const out = extractFrameContent({ frameIndex: 1, maxRefs: 200, epochSeed: 1 });
    expect(out).toContain('[g1f1e1] button "Only"');
    expect(document.querySelector('[data-curia-ref="g1f1e1"]')).not.toBeNull();
  });

  // Bug-2 guarantee: because every action re-reads the page, a ref must survive re-extraction.
  // A re-extracted document keeps the epoch it already adopted (ignoring the handler's newer
  // epochSeed), so existing refs are unchanged and a never-reused seq means a newly-inserted
  // element can't steal an existing element's ref (which would silently address the wrong one).
  it('keeps refs stable across re-extractions of the same document', () => {
    document.body.innerHTML = '<button>A</button><button>B</button>';
    extractFrameContent({ frameIndex: 0, maxRefs: 200, epochSeed: 1 });
    expect(document.querySelectorAll('button')[0]!.getAttribute('data-curia-ref')).toBe('g1f0e1');
    const bRef = document.querySelectorAll('button')[1]!.getAttribute('data-curia-ref');  // g1f0e2
    // Prepend a new element and re-extract WITH A NEWER epochSeed (as the handler passes each
    // action). Same document → epoch stays 1, existing refs untouched, only Z gets a fresh id.
    document.body.insertAdjacentHTML('afterbegin', '<button>Z</button>');
    extractFrameContent({ frameIndex: 0, maxRefs: 200, epochSeed: 2 });
    // A and B keep their refs — the earlier g1f0e1 still addresses A, NOT the newly-prepended Z.
    expect(document.querySelector('[data-curia-ref="g1f0e1"]')!.textContent).toBe('A');
    expect(document.querySelector('[data-curia-ref="g1f0e2"]')!.textContent).toBe('B');
    // Z, seen first this extraction, got the next never-reused id at the SAME epoch (g1f0e3).
    const zRef = document.querySelector('button')!.getAttribute('data-curia-ref');
    expect(zRef).toBe('g1f0e3');
    expect(zRef).not.toBe(bRef);
  });

  // Finding-1 guarantee: across a navigation the page's window (and its per-document counters)
  // resets, so the seq alone would recycle e-numbers onto the new page. The monotonic epochSeed
  // makes the new document adopt a DIFFERENT epoch, so a ref from the old page carries an older
  // epoch and matches nothing on the new page (fail closed) rather than clicking the wrong one.
  it('stamps a fresh epoch on a new document so a prior-page ref no longer matches', () => {
    document.body.innerHTML = '<button>OldPageButton</button>';
    extractFrameContent({ frameIndex: 0, maxRefs: 200, epochSeed: 1 });
    expect(document.querySelector('[data-curia-ref="g1f0e1"]')!.textContent).toBe('OldPageButton');
    // Simulate a navigation: the window resets (new document), and the handler's monotonic seed
    // has advanced. The new page's first element is e1 again, but under a NEW epoch.
    resetRefState();
    document.body.innerHTML = '<button>NewPageButton</button>';
    extractFrameContent({ frameIndex: 0, maxRefs: 200, epochSeed: 2 });
    // The new element carries epoch 2, not 1 — so the old g1f0e1 ref addresses NO live element.
    expect(document.querySelector('[data-curia-ref="g2f0e1"]')!.textContent).toBe('NewPageButton');
    expect(document.querySelector('[data-curia-ref="g1f0e1"]')).toBeNull();
  });

  // Point-3 guarantee: page.frames() ordering is not stable — removing a preceding sibling
  // frame shifts survivors to lower indices. A document pins its frame scope at adoption, so a
  // later read that passes a DIFFERENT frameIndex must not renumber its refs; otherwise a frame
  // sliding into a vacated index could mint refs colliding with another same-epoch frame's.
  it('pins the frame scope at adoption so a later frame-index shift never renumbers refs', () => {
    document.body.innerHTML = '<button>X</button>';
    extractFrameContent({ frameIndex: 2, maxRefs: 200, epochSeed: 1 });   // adopt at index 2
    expect(document.querySelector('[data-curia-ref="g1f2e1"]')!.textContent).toBe('X');
    // Re-read as if this frame shifted to index 1 (a preceding sibling was removed). The new
    // element still mints under the ADOPTED scope (f2), NOT the current index — so it can never
    // collide with whatever frame now occupies index 1.
    document.body.insertAdjacentHTML('beforeend', '<button>Y</button>');
    extractFrameContent({ frameIndex: 1, maxRefs: 200, epochSeed: 2 });
    expect(document.querySelector('[data-curia-ref="g1f2e1"]')!.textContent).toBe('X');
    expect(document.querySelector('[data-curia-ref="g1f2e2"]')!.textContent).toBe('Y');
    expect(document.querySelector('[data-curia-ref="g1f1e2"]')).toBeNull();
  });

  // Regression: extractFrameContent is shipped to the browser via Playwright's
  // frame.evaluate(), which serializes it with .toString() and re-parses it in the page's
  // scope. Prod loads skills via tsx (esbuild keepNames: true), which wraps named inner
  // functions in __name(...) — a module-scope helper that does NOT exist in the page, so a
  // named inner function throws `__name is not defined` on every frame. vitest's own
  // transpile has keepNames OFF, so a plain import can't catch this; we transpile the source
  // the way prod does, then run the function in a fresh scope like frame.evaluate.
  it('stays self-contained when serialized into a page after a keepNames transpile (prod pipeline)', async () => {
    // Resolve via cwd (worktree root under `pnpm -C`, repo root in CI) rather than
    // import.meta.url — happy-dom gives a non-file: import.meta.url here.
    const srcPath = resolve(process.cwd(), 'skills/web/tools/web-browser/dom-extract.ts');
    const { code } = await transformWithEsbuild(readFileSync(srcPath, 'utf8'), srcPath, {
      keepNames: true, loader: 'ts', format: 'cjs',
    });
    // Execute the transpiled CJS to get the keepNames-wrapped function. Its own module scope
    // defines __name, so it works when called normally here.
    const shim: { exports: Record<string, unknown> } = { exports: {} };
    new Function('module', 'exports', code)(shim, shim.exports);
    const transpiled = shim.exports.extractFrameContent as typeof extractFrameContent;
    // Rehydrate exactly as frame.evaluate does: serialize -> re-parse in a fresh scope with
    // no access to the module's __name helper. A named inner function throws `__name is not
    // defined` here.
    const rehydrated = new Function(`return (${transpiled.toString()})`)() as typeof extractFrameContent;
    document.body.innerHTML = '<button>Go</button>';
    let out = '';
    expect(() => { out = rehydrated({ frameIndex: 0, maxRefs: 200, epochSeed: 1 }); }).not.toThrow();
    expect(out).toContain('[g1f0e1] button "Go"');
  });
});
