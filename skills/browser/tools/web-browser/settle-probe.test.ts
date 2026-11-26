// @vitest-environment happy-dom
//
// Unit tests for the in-page half of the settle check (#2244): what counts as a blank page
// and what counts as a sign-in form. Runs against fixture HTML under happy-dom.
import { describe, it, expect, beforeEach } from 'vitest';
import { transformWithEsbuild } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { probeFrameContent } from './settle-probe.js';

describe('probeFrameContent', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  // The case from the Air Canada sign-in: the post-consent handoff page held a single SVG
  // logo link whose textContent was CSS. It has one "interactable" and no meaningful content.
  it('treats a page holding only an SVG logo link as blank', () => {
    document.body.innerHTML = `
      <a href="/"><svg viewBox="0 0 10 10"><style>.st0{fill:#f01428}.st1{fill:#2e2a25}.st2{fill:#ffffff;stroke:#2e2a25}</style><path class="st1" d="M0 0h10v10H0z"/></svg></a>`;
    const probe = probeFrameContent();
    expect(probe.labelledControls).toBe(0);
    expect(probe.credentialFields).toBe(0);
    expect(probe.textChars).toBeLessThan(25);
  });

  it('does not count an unnamed button or an image without alt', () => {
    document.body.innerHTML = '<button></button><button><img src="x.png"></button>';
    expect(probeFrameContent().labelledControls).toBe(0);
  });

  it('counts a button named by its text, aria-label or image alt', () => {
    document.body.innerHTML = `
      <button>Continue</button>
      <button aria-label="Close"></button>
      <button><img src="x.png" alt="Search"></button>`;
    expect(probeFrameContent().labelledControls).toBe(3);
  });

  it('counts a labelled field and flags a sign-in form', () => {
    document.body.innerHTML = `
      <form>
        <label for="u">Aeroplan number or email</label><input id="u" name="username">
        <label for="p">Password</label><input id="p" type="password">
        <button type="submit">Sign in</button>
      </form>`;
    const probe = probeFrameContent();
    expect(probe.labelledControls).toBe(3);
    expect(probe.credentialFields).toBe(2);
  });

  it('flags a one-time-code field', () => {
    document.body.innerHTML = '<input autocomplete="one-time-code" aria-label="Verification code">';
    expect(probeFrameContent().credentialFields).toBe(1);
  });

  it('does not flag an ordinary search form as a sign-in form', () => {
    document.body.innerHTML = `
      <label for="from">From</label><input id="from" name="origin">
      <label for="to">To</label><input id="to" name="destination">
      <button>Search flights</button>`;
    const probe = probeFrameContent();
    expect(probe.labelledControls).toBe(3);
    expect(probe.credentialFields).toBe(0);
  });

  it('ignores hidden controls', () => {
    document.body.innerHTML = `
      <button style="display:none">Hidden</button>
      <div style="visibility:hidden"><input type="password" aria-label="Password"></div>`;
    const probe = probeFrameContent();
    expect(probe.labelledControls).toBe(0);
    expect(probe.credentialFields).toBe(0);
  });

  it('counts visible body text', () => {
    document.body.innerHTML = '<p>Welcome back, Jordan. You have 12,345 points.</p>';
    expect(probeFrameContent().textChars).toBeGreaterThan(25);
  });

  // Prod loads skills via tsx (esbuild keepNames: true), which wraps named inner functions in
  // __name(...), a helper that does not exist in the page. Same guard as dom-extract.test.ts.
  it('stays self-contained when serialized into a page after a keepNames transpile', async () => {
    const srcPath = resolve(process.cwd(), 'skills/browser/tools/web-browser/settle-probe.ts');
    const { code } = await transformWithEsbuild(readFileSync(srcPath, 'utf8'), srcPath, {
      keepNames: true, loader: 'ts', format: 'cjs',
    });
    const shim: { exports: Record<string, unknown> } = { exports: {} };
    // The transpiled module requires nothing at runtime (its imports are type-only).
    new Function('module', 'exports', 'require', code)(shim, shim.exports, () => ({}));
    const transpiled = shim.exports.probeFrameContent as typeof probeFrameContent;
    const rehydrated = new Function(`return (${transpiled.toString()})`)() as typeof probeFrameContent;
    document.body.innerHTML = '<input type="password" aria-label="Password">';
    let out: ReturnType<typeof probeFrameContent> | undefined;
    expect(() => { out = rehydrated(); }).not.toThrow();
    expect(out?.credentialFields).toBe(1);
  });
});
