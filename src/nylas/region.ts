// The Nylas data-center region (#2361). A Nylas application lives in one region, and its
// API key only works against that region's API host, so the host must be selectable.

export type NylasRegion = 'us' | 'eu';

const API_URIS: Record<NylasRegion, string> = {
  us: 'https://api.us.nylas.com',
  eu: 'https://api.eu.nylas.com',
};

/**
 * Parse an operator-supplied region. Blank or absent reads as the default, 'us'; case and
 * surrounding whitespace are ignored. An unrecognised value is `null`, so the caller decides
 * whether to warn and fall back or to reject it.
 */
export function parseNylasRegion(raw: string | undefined): NylasRegion | null {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return 'us';
  if (value === 'us' || value === 'eu') return value;
  return null;
}

/** The API base URL (no trailing slash, no path) for a region. */
export function nylasApiUri(region: NylasRegion): string {
  return API_URIS[region];
}
