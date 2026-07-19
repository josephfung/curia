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

const OPTS = { frameIndex: 0, maxRefs: 200, generation: 1 };

describe('extractFrameContent — interactable refs', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

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
    const out = extractFrameContent({ frameIndex: 0, maxRefs: 2, generation: 1 });
    expect(out).toContain('[g1f0e1] button "B0"');
    expect(out).toContain('[g1f0e2] button "B1"');
    expect(out).not.toContain('[g1f0e3]');
    expect(out).toContain('(3 more interactable elements not shown');
    // Only the capped elements receive refs.
    expect(document.querySelectorAll('[data-curia-ref]').length).toBe(2);
  });

  it('clears stale refs before reassigning on re-extraction', () => {
    document.body.innerHTML = '<button>One</button><button>Two</button>';
    extractFrameContent(OPTS);
    document.querySelectorAll('button')[1]!.remove();  // element gone before next snapshot
    extractFrameContent(OPTS);
    expect(document.querySelectorAll('[data-curia-ref]').length).toBe(1);
    expect(document.querySelector('[data-curia-ref="g1f0e2"]')).toBeNull();
  });

  it('emits no Interactable section when the page has none', () => {
    document.body.innerHTML = '<p>Just some prose, nothing to click.</p>';
    const out = extractFrameContent(OPTS);
    expect(out).not.toContain('--- Interactable elements ---');
    expect(out).toContain('Just some prose');
  });

  it('scopes the ref prefix to the frame index (cross-frame uniqueness)', () => {
    document.body.innerHTML = '<button>Only</button>';
    const out = extractFrameContent({ frameIndex: 1, maxRefs: 200, generation: 1 });
    expect(out).toContain('[g1f1e1] button "Only"');
    expect(document.querySelector('[data-curia-ref="g1f1e1"]')).not.toBeNull();
  });

  it('stamps a fresh generation each extraction so a prior-snapshot ref no longer matches', () => {
    document.body.innerHTML = '<button>A</button><button>B</button>';
    extractFrameContent({ frameIndex: 0, maxRefs: 200, generation: 1 });
    expect(document.querySelectorAll('button')[0]!.getAttribute('data-curia-ref')).toBe('g1f0e1');
    // Prepend an element and re-serialize with the next generation (as getCleanedContent does).
    document.body.insertAdjacentHTML('afterbegin', '<button>Z</button>');
    extractFrameContent({ frameIndex: 0, maxRefs: 200, generation: 2 });
    // The old ref now exists on NO element, so a stale action fails closed instead of hitting
    // whatever inherited e1 (here Z).
    expect(document.querySelector('[data-curia-ref="g1f0e1"]')).toBeNull();
    // New refs carry generation 2; e1 is the newly-prepended Z, not A.
    expect(document.querySelector('[data-curia-ref="g2f0e1"]')!.textContent).toBe('Z');
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
    const srcPath = resolve(process.cwd(), 'skills/web-browser/dom-extract.ts');
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
    expect(() => { out = rehydrated({ frameIndex: 0, maxRefs: 200, generation: 1 }); }).not.toThrow();
    expect(out).toContain('[g1f0e1] button "Go"');
  });
});
