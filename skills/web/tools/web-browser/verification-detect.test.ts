// @vitest-environment happy-dom
//
// Unit tests for the sign-in verification screen detector (#2017). The in-page half runs
// under happy-dom against fixture HTML; the server-side wrapper is tested with a fake page.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { transformWithEsbuild } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from 'playwright';
import { collectVerificationSignals, detectVerificationScreen } from './verification-detect.js';

describe('collectVerificationSignals (in-page)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('flags autocomplete=one-time-code', () => {
    document.body.innerHTML = `
      <h1>Check your phone</h1>
      <input type="text" name="otp" autocomplete="one-time-code">
      <button>Verify</button>`;
    expect(collectVerificationSignals()).toContain('one-time-code-input');
  });

  it('flags delivery-choice wording', () => {
    document.body.innerHTML = `
      <h1>Verify it's you</h1>
      <p>How would you like to receive your code?</p>
      <button>Send code by email</button>
      <button>Text me a code</button>`;
    expect(collectVerificationSignals()).toEqual(['delivery-choice']);
  });

  it('flags a short numeric input next to code-entry wording', () => {
    document.body.innerHTML = `
      <p>Enter the 6-digit verification code we sent to your phone.</p>
      <input type="text" inputmode="numeric" maxlength="6">`;
    expect(collectVerificationSignals()).toEqual(['short-numeric-input-with-code-wording']);
  });

  it('does not flag a short numeric input without code wording', () => {
    document.body.innerHTML = `
      <label>Postal code digits <input type="tel" maxlength="7"></label>
      <label>Quantity <input type="number" maxlength="3"></label>`;
    expect(collectVerificationSignals()).toEqual([]);
  });

  it('returns [] for an ordinary login page', () => {
    document.body.innerHTML = `
      <h1>Sign in to your account</h1>
      <form>
        <label>Email <input type="email" name="email" autocomplete="username"></label>
        <label>Password <input type="password" name="password" autocomplete="current-password"></label>
        <label><input type="checkbox"> Remember me</label>
        <a href="/forgot">Forgot password? We'll email you a reset link.</a>
        <button type="submit">Sign in</button>
      </form>`;
    expect(collectVerificationSignals()).toEqual([]);
  });

  // Prod loads skills via tsx (esbuild keepNames: true), which wraps named inner functions in
  // __name(...), a helper that does not exist in the page. Same guard as dom-extract.test.ts.
  it('stays self-contained when serialized into a page after a keepNames transpile', async () => {
    const srcPath = resolve(process.cwd(), 'skills/web/tools/web-browser/verification-detect.ts');
    const { code } = await transformWithEsbuild(readFileSync(srcPath, 'utf8'), srcPath, {
      keepNames: true, loader: 'ts', format: 'cjs',
    });
    const shim: { exports: Record<string, unknown> } = { exports: {} };
    // The transpiled module requires nothing at runtime (its imports are type-only).
    new Function('module', 'exports', 'require', code)(shim, shim.exports, () => ({}));
    const transpiled = shim.exports.collectVerificationSignals as typeof collectVerificationSignals;
    const rehydrated = new Function(`return (${transpiled.toString()})`)() as typeof collectVerificationSignals;
    document.body.innerHTML = '<input autocomplete="one-time-code">';
    let out: string[] = [];
    expect(() => { out = rehydrated(); }).not.toThrow();
    expect(out).toEqual(['one-time-code-input']);
  });
});

describe('detectVerificationScreen (server side)', () => {
  const log = { debug: vi.fn() };

  function fakePage(evaluate: () => Promise<unknown>): Page {
    return { evaluate: vi.fn(evaluate) } as unknown as Page;
  }

  it('returns the known signals the page reported', async () => {
    const page = fakePage(async () => ['one-time-code-input', 'delivery-choice']);
    expect(await detectVerificationScreen(page)).toEqual(['one-time-code-input', 'delivery-choice']);
  });

  it('drops anything that is not a known signal name', async () => {
    const page = fakePage(async () => ['one-time-code-input', 'pwned', 7]);
    expect(await detectVerificationScreen(page)).toEqual(['one-time-code-input']);
  });

  it('returns [] when the page returns something other than an array', async () => {
    expect(await detectVerificationScreen(fakePage(async () => 'page text'))).toEqual([]);
  });

  it('returns [] and logs at debug when evaluation throws', async () => {
    const page = fakePage(async () => { throw new Error('Execution context was destroyed'); });
    expect(await detectVerificationScreen(page, log as never)).toEqual([]);
    expect(log.debug).toHaveBeenCalledTimes(1);
  });
});
