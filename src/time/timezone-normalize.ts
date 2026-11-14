// timezone-normalize.ts — one rule for "is this a timezone Curia can compute with?"
//
// Contact timezones arrive from many writers: the setup wizard, the console's free-text
// field, contact-update, memory-store, and extract-facts reading email. The last one is
// how a Google Calendar invite footer ("Eastern Time - Toronto") ended up stored as the
// principal's timezone; Luxon rejects that string, and inbox triage threw on every tick.
// Every contact-timezone write now goes through normalizeTimezone() so only zones the
// runtime can actually use are stored.

import { IANAZone } from 'luxon';

/** True when Luxon (and so every consumer that formats or buckets times) accepts the zone. */
export function isValidTimezone(tz: string): boolean {
  const trimmed = tz.trim();
  return trimmed !== '' && IANAZone.isValidZone(trimmed);
}

/**
 * The zone to compute with: `preferred` when it is valid, else `fallback` (the instance's
 * validated config.timezone). `rejected` is set when a preferred value was present but
 * unusable, so the caller can warn: a bad stored value must degrade to the instance zone,
 * never stop the work that needs a zone (inbox triage did, on every tick).
 */
export function usableTimezone(
  preferred: string | null | undefined,
  fallback: string,
): { zone: string; rejected?: string } {
  if (preferred === null || preferred === undefined) return { zone: fallback };
  if (isValidTimezone(preferred)) return { zone: preferred.trim() };
  return { zone: fallback, rejected: preferred };
}

// Separator between the region and the city in calendar-style labels:
// "Eastern Time - Toronto" (Google Calendar), with en/em dash variants. Matched after
// whitespace is collapsed to single spaces: a `\s+`-led pattern backtracks quadratically on a
// long whitespace run with no dash (60k spaces took ~20s), and the console field takes 64 KiB.
const LABEL_SEPARATOR = / [-–—] /;

// City (last path segment, lowercased, spaces as underscores) → zones ending in it.
// Built lazily: Intl.supportedValuesOf is cheap but there is no reason to pay for it
// on boot paths that never see a label.
let cityIndex: Map<string, string[]> | undefined;

function zonesForCity(city: string): string[] {
  if (!cityIndex) {
    cityIndex = new Map();
    for (const zone of Intl.supportedValuesOf('timeZone')) {
      const last = zone.split('/').pop();
      if (!last) continue;
      const key = last.toLowerCase();
      const list = cityIndex.get(key);
      if (list) list.push(zone);
      else cityIndex.set(key, [zone]);
    }
  }
  return cityIndex.get(city) ?? [];
}

/**
 * Normalize a timezone to a value the runtime can use, or null when there is no safe answer.
 *
 * - A valid zone is kept, with only its casing fixed ("america/toronto" → "America/Toronto").
 *   An alias is NOT swapped for its canonical zone ("EST" stays "EST", not "America/Panama"):
 *   storing a different name than the caller gave would be more surprising than keeping theirs.
 * - A calendar-style label is mapped by its city when exactly one zone ends in that city:
 *   "Eastern Time - Toronto" → "America/Toronto". A bare city name works the same way.
 * - Anything else ("Eastern Time - US & Canada", "Eastern Time") is null: a region spanning
 *   several zones has no single correct answer, and guessing would silently shift times.
 */
export function normalizeTimezone(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  if (isValidTimezone(trimmed)) {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).resolvedOptions().timeZone;
    return resolved.toLowerCase() === trimmed.toLowerCase() ? resolved : trimmed;
  }

  const parts = trimmed.replace(/\s+/g, ' ').split(LABEL_SEPARATOR);
  const cityPart = parts[parts.length - 1]?.trim();
  if (!cityPart) return null;
  const matches = zonesForCity(cityPart.toLowerCase().replace(/\s+/g, '_'));
  return matches.length === 1 ? matches[0]! : null;
}
