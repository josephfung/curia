// clear-site-data.ts — the clear_site_data action (#2244): forget one host in the browser
// profile, leaving every other site signed in.
//
// The recovery for an interrupted sign-in. When the agent navigated away mid-chain from
// Air Canada's sign-in, the login service kept a session but aircanada.com never got its
// signed-in cookie, and every later /signin in the profile hung on a blank consent page.
// Before this action the only way out was an incognito session, which can't keep a sign-in.
//
// Scope is what the given host can see, by the browser's own cookie rule: its cookies,
// its subdomains' cookies, and the parent-domain cookies the browser sends to it. No list
// of shared hosts is needed. acme.okta.com clears that tenant and leaves other.okta.com
// signed in; www.aircanada.com reaches the .aircanada.com cookies the stuck sign-in left;
// the bare aircanada.com clears everything under it.

import type { BrowserContext, Frame, Page } from 'playwright';
import type { ToolContext } from '../../../../src/skills/types.js';
import { registrableDomain } from '../../../../src/verification/domain.js';

export interface ClearSiteDataResult {
  /** The host cleared, e.g. "www.aircanada.com" or "acme.okta.com". */
  host: string;
  cookiesCleared: number;
  /** Origins whose storage was cleared. */
  originsCleared: string[];
}

/**
 * Normalize a `domain` input (a bare host or a URL) to a lowercase host, or null when it
 * isn't a website host: an IP address, a bare public suffix ("com"), or junk.
 */
export function hostForDomainInput(domain: string): string | null {
  const trimmed = domain.trim();
  if (trimmed === '') return null;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return null;
  }
  host = host.toLowerCase().replace(/\.$/, '');
  return registrableDomain(host) === null ? null : host;
}

/** True when `candidate` (a host or cookie domain without its dot) is `host` or under it. */
function atOrUnder(candidate: string, host: string): boolean {
  return candidate === host || candidate.endsWith(`.${host}`);
}

/**
 * True when the browser would send this cookie to `host` or one of its subdomains, or it
 * belongs to one of them: a cookie on the host or under it, or a domain cookie (leading
 * dot) on one of the host's parents. A host-only cookie on a parent is not sent to the
 * host, so it stays.
 */
function cookieVisibleTo(cookieDomain: string, host: string): boolean {
  const isDomainCookie = cookieDomain.startsWith('.');
  const d = cookieDomain.replace(/^\./, '').toLowerCase();
  return atOrUnder(d, host) || (isDomainCookie && host.endsWith(`.${d}`));
}

/**
 * Clear what `host` can see from `context`: the cookies above (one by one, so no other
 * host's cookie is touched), and storage for the host and its subdomains. Storage is per
 * origin, so the origins come from the host, the cookies under it, and the frames open on it.
 */
export async function clearSiteData(
  context: BrowserContext,
  page: Page,
  host: string,
  log: ToolContext['log'],
): Promise<ClearSiteDataResult> {
  const visible = (await context.cookies()).filter((c) => cookieVisibleTo(c.domain, host));

  const hosts = new Set<string>([host]);
  for (const c of visible) {
    const d = c.domain.replace(/^\./, '').toLowerCase();
    if (atOrUnder(d, host)) hosts.add(d);
  }
  const hostFrames: Frame[] = [];
  for (const openPage of context.pages()) {
    for (const frame of openPage.frames()) {
      let frameHost: string;
      try {
        frameHost = new URL(frame.url()).hostname.toLowerCase();
      } catch {
        // about:blank and the like have no host to clear.
        continue;
      }
      if (atOrUnder(frameHost, host)) {
        hosts.add(frameHost);
        hostFrames.push(frame);
      }
    }
  }

  for (const c of visible) {
    await context.clearCookies({ name: c.name, domain: c.domain, path: c.path });
  }

  const origins = [...hosts].sort().flatMap((h) => [`https://${h}`, `http://${h}`]);
  const cdp = await context.newCDPSession(page);
  try {
    for (const origin of origins) {
      // 'all' covers local storage, IndexedDB, cache storage and service workers.
      await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    }
  } finally {
    await cdp.detach().catch((err: unknown) => log.debug({ err }, 'clear_site_data: CDP session detach failed'));
  }

  // Session storage belongs to a tab, not an origin, so the CDP call above leaves it.
  // Clear it in the frames open on the host; a frame that is navigating is skipped.
  for (const frame of hostFrames) {
    // A string expression: this file has no DOM lib (see dom-extract.ts).
    await frame.evaluate('sessionStorage.clear()').catch((err: unknown) =>
      // Origin only: a frame mid-navigation may be on a callback URL carrying an auth code.
      log.debug({ err, frameOrigin: originOf(frame.url()) }, 'clear_site_data: could not clear session storage in a frame'),
    );
  }

  log.info({ host, cookiesCleared: visible.length, origins: origins.length }, 'Cleared site data from the browser profile');
  return { host, cookiesCleared: visible.length, originsCleared: origins };
}

/** The origin of `url`, or a placeholder when it has none. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    // Not a URL (about:blank already has origin "null"); nothing identifying to log.
    return '(no origin)';
  }
}
