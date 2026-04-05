// timestamp.ts — centralized "timestamp" skill input type handling.
//
// Skills declare inputs as "timestamp" or "timestamp?" in their manifests.
// The SkillRegistry maps this to a string schema with the canonical description
// from describeTimestampInput(). The ExecutionLayer calls normalizeTimestamp()
// before invoking any handler, so handlers always receive UTC Z-suffix strings
// and never need to know Curia's timezone themselves.
//
// Why this matters: the server container runs in UTC with no TZ env var. If the
// LLM emits an offset-less ISO string like "2026-04-06T08:00:00", new Date()
// parses it as UTC midnight — four hours ahead of Toronto midnight in EDT.
// normalizeTimestamp() fixes this by treating offset-less strings as
// Curia's local time and converting to UTC before the handler sees them.

import { DateTime } from 'luxon';

/**
 * Description fragment injected into LLM tool schemas for `timestamp` inputs.
 * Tells the model what format to emit so normalization can handle the result.
 *
 * @param defaultZone  IANA timezone name (e.g. "America/Toronto")
 */
export function describeTimestampInput(defaultZone: string): string {
  return (
    `ISO 8601 datetime string. ` +
    `Prefer a UTC offset (e.g. "2026-04-06T08:00:00-04:00") for precision. ` +
    `If no offset is provided, the value is interpreted as local to Curia's timezone (${defaultZone}).`
  );
}

/**
 * Normalize an ISO string to a UTC Z-suffix string.
 *
 * Rules:
 * - Strings with an explicit offset ("+HH:MM", "-HH:MM") or "Z" are parsed
 *   offset-aware and converted to UTC.
 * - Offset-less strings (e.g. "2026-04-06T08:00:00") are interpreted as
 *   `defaultZone` local time via luxon (DST-safe), then converted to UTC.
 *
 * Returns a Z-suffix string (e.g. "2026-04-06T12:00:00.000Z") safe to pass
 * to new Date() or any skill handler expecting a UTC epoch.
 *
 * Throws if the input cannot be parsed as a valid datetime.
 *
 * @param iso          The raw ISO string from the LLM
 * @param defaultZone  IANA timezone name (e.g. "America/Toronto")
 */
export function normalizeTimestamp(iso: string, defaultZone: string): string {
  const trimmed = iso.trim();

  // Detect whether the string carries an explicit offset.
  // Matches: trailing Z/z, ±HH:MM, ±HHMM, or bare ±HH — but only when a time
  // component is present (requires T/t) to avoid false matches on date-only strings.
  const hasOffset =
    /[zZ]$/.test(trimmed) ||
    (/[+-]\d{2}(?::?\d{2})?$/.test(trimmed) && /[Tt]/.test(trimmed));

  if (hasOffset) {
    // Already offset-aware — parse normally and re-emit as UTC.
    const d = new Date(trimmed);
    if (isNaN(d.getTime())) {
      throw new Error(`Invalid timestamp: "${iso}"`);
    }
    return d.toISOString();
  }

  // Offset-less — interpret as defaultZone local time (DST-aware via luxon).
  const dt = DateTime.fromISO(trimmed, { zone: defaultZone });
  if (!dt.isValid) {
    throw new Error(`Invalid timestamp: "${iso}" (${dt.invalidReason ?? 'unknown reason'})`);
  }
  return dt.toUTC().toISO()!;
}
