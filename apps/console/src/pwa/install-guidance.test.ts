import { describe, expect, it } from 'vitest';
import { installGuidance } from './install-guidance.js';
import { accessKeyLoginRequested, isIosBrowser, signedOutPath } from './standalone.js';

describe('signedOutPath', () => {
  it('sends the installed app to pairing and a browser to login', () => {
    expect(signedOutPath(true)).toBe('/pair');
    expect(signedOutPath(false)).toBe('/login');
  });

  it('keeps the access-key form only for ?key=1', () => {
    expect(accessKeyLoginRequested('?key=1')).toBe(true);
    expect(accessKeyLoginRequested('key=1')).toBe(true);
    expect(accessKeyLoginRequested('?key=2')).toBe(false);
    expect(accessKeyLoginRequested('')).toBe(false);
  });
});

describe('isIosBrowser', () => {
  it('recognises iPhone, iPad, and iPadOS desktop Safari', () => {
    expect(isIosBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)')).toBe(true);
    expect(isIosBrowser('Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X)')).toBe(true);
    expect(isIosBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Mobile/15E148')).toBe(true);
    expect(isIosBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0')).toBe(false);
  });
});

describe('installGuidance', () => {
  it('stays quiet inside the installed app', () => {
    expect(installGuidance({ ios: true, standalone: true, promptAvailable: true })).toEqual({ kind: 'installed' });
  });

  it('offers the browser prompt, otherwise iOS share steps', () => {
    expect(installGuidance({ ios: false, standalone: false, promptAvailable: true })).toEqual({ kind: 'prompt' });
    expect(installGuidance({ ios: true, standalone: false, promptAvailable: false })).toEqual({ kind: 'ios-share' });
    expect(installGuidance({ ios: false, standalone: false, promptAvailable: false })).toEqual({ kind: 'browser-menu' });
  });
});
