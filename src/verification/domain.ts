// Registrable-domain helpers for the sign-in verification feature.
//
// A "registrable domain" is the public suffix plus one label (aircanada.com,
// example.co.uk). Comparing on it, rather than on hostnames, lets a login page
// on login.aircanada.com match a site recorded as aircanada.com while still
// rejecting lookalikes such as aircanada.com.evil.io.

import { getDomain } from 'tldts';

/**
 * Registrable domain of a URL or bare host, lowercased.
 * Returns null for IP addresses, bare public suffixes, and anything unparseable.
 * Private suffixes are deliberately not honoured (default tldts behaviour), so
 * tenant hosts such as manulife.b2clogin.com resolve to b2clogin.com.
 */
export function registrableDomain(urlOrHost: string): string | null {
  const input = urlOrHost.trim();
  if (input === '') return null;
  const domain = getDomain(input);
  return domain === null ? null : domain.toLowerCase();
}

/** True when both inputs have a registrable domain and it is the same one. */
export function sameRegistrableDomain(a: string, b: string): boolean {
  const da = registrableDomain(a);
  const db = registrableDomain(b);
  return da !== null && db !== null && da === db;
}
