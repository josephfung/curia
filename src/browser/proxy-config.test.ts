// src/browser/proxy-config.test.ts — parseProxyConfig unit tests.
//
// The security-critical contract is FAIL-CLOSED: a non-empty but unparseable value must
// throw (abort boot) rather than resolve to `undefined` and let the browser egress directly
// from the datacenter IP this feature exists to hide.

import { describe, it, expect } from 'vitest';
import { parseProxyConfig } from './proxy-config.js';

describe('parseProxyConfig', () => {
  // --- No proxy: the ONLY inputs that legitimately resolve to undefined ---
  it('returns undefined for empty/absent input (intentional direct egress)', () => {
    expect(parseProxyConfig(undefined)).toBeUndefined();
    expect(parseProxyConfig('')).toBeUndefined();
    expect(parseProxyConfig('   ')).toBeUndefined();
  });

  // --- Valid proxies ---
  it('parses a scheme://host:port with no credentials', () => {
    expect(parseProxyConfig('http://browser-wg:8888')).toEqual({ server: 'http://browser-wg:8888' });
  });

  it('splits embedded credentials out of the server field', () => {
    // Playwright wants `server` credential-free and username/password separate.
    expect(parseProxyConfig('http://user:pass@10.0.0.5:3128')).toEqual({
      server: 'http://10.0.0.5:3128',
      username: 'user',
      password: 'pass',
    });
  });

  it('URL-decodes percent-encoded credentials', () => {
    expect(parseProxyConfig('http://us%40er:p%3Ass@host:8888')).toEqual({
      server: 'http://host:8888',
      username: 'us@er',
      password: 'p:ss',
    });
  });

  it('supports socks5 proxies (no auth field)', () => {
    expect(parseProxyConfig('socks5://host:1080')).toEqual({ server: 'socks5://host:1080' });
  });

  it('treats a bare host:port as http (normalizes to a scheme)', () => {
    expect(parseProxyConfig('browser-wg:8888')).toEqual({ server: 'http://browser-wg:8888' });
  });

  // --- Fail-closed: non-empty but invalid must THROW, never return undefined ---
  it('throws on whitespace inside an otherwise-set value (a likely hand-edit typo)', () => {
    // Regression for the silent-leak finding: "http://browser-wg :8888" must not degrade
    // to direct egress.
    expect(() => parseProxyConfig('http://browser-wg :8888')).toThrow(/browser\.proxy/);
    expect(() => parseProxyConfig('browser wg:8888')).toThrow(/browser\.proxy/);
  });

  it('throws on an unparseable value', () => {
    expect(() => parseProxyConfig('not a url at all')).toThrow(/browser\.proxy/);
    expect(() => parseProxyConfig('://oops')).toThrow(/browser\.proxy/);
  });

  it('throws on a scheme with no host instead of emitting a bogus server', () => {
    expect(() => parseProxyConfig('http://')).toThrow(/browser\.proxy/);
  });

  it('throws (does not crash with an opaque URIError) on a bare % in credentials', () => {
    // Regression for the boot-crash finding: decodeURIComponent throws URIError on "%ss".
    expect(() => parseProxyConfig('http://user:pa%ss@host:8888')).toThrow(/percent-encoding/);
  });
});
