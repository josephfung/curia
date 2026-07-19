// src/browser/proxy-config.ts — parse the browser egress-proxy config string.
//
// Kept in its own module (no runtime deps beyond the URL global, and only a type-only
// playwright import) so config.ts can validate the value at load time WITHOUT importing
// browser-service.ts, which pulls in patchright/Chromium. (residential-proxy support)

import type { BrowserContextOptions } from 'playwright';

/** Playwright's proxy shape: a credential-free `server` plus optional auth. */
export type ProxyConfig = NonNullable<BrowserContextOptions['proxy']>;

/**
 * Parse a proxy config string into Playwright's ProxySettings.
 *
 * Contract (deliberately FAIL-CLOSED — this feature exists to stop the browser leaking the
 * real datacenter IP, so a misconfiguration must never silently degrade to direct egress):
 *   - empty / whitespace / undefined → `undefined` (operator intends NO proxy, direct egress)
 *   - a valid proxy (`http://user:pass@host:port`, `socks5://host:1080`, bare `host:port`)
 *     → the parsed ProxyConfig
 *   - a NON-EMPTY but unparseable value → THROWS. A typo'd proxy must abort boot loudly,
 *     not resolve to `undefined` and egress directly.
 *
 * Credentials embedded in the URL are split out because Playwright wants `server` WITHOUT
 * credentials and `username`/`password` as separate fields.
 */
export function parseProxyConfig(raw: string | undefined): ProxyConfig | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  const trimmed = raw.trim();

  // Accept an explicit scheme (http/https/socks5/...); otherwise treat the value as a bare
  // host:port and normalize to http so `server` is unambiguous. The regex requires "://"
  // so a bare "host:port" (which has a colon but no "//") correctly falls through to http.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`browser.proxy is not a valid proxy URL: ${JSON.stringify(raw)}`);
  }
  // new URL('http://') succeeds with an empty host; reject it rather than emitting a bogus
  // server like "http://http".
  if (!url.hostname) {
    throw new Error(`browser.proxy has no host: ${JSON.stringify(raw)}`);
  }

  // decodeURIComponent throws URIError on a bare '%' (a common char in generated passwords
  // that new URL happily preserves). Catch it and fail closed with a clear message instead
  // of an opaque URIError crashing boot from outside any handler. (#finding: %-in-password)
  let username: string | undefined;
  let password: string | undefined;
  try {
    username = url.username ? decodeURIComponent(url.username) : undefined;
    password = url.password ? decodeURIComponent(url.password) : undefined;
  } catch {
    throw new Error('browser.proxy has malformed percent-encoding in its credentials');
  }

  return {
    // url.protocol includes the trailing colon; url.host includes the port.
    server: `${url.protocol}//${url.host}`,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}
