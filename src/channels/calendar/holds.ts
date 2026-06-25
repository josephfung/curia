// src/channels/calendar/holds.ts
//
// Shared pure-function helpers for calendar hold management.
// These are used by the calendar-create-hold skill (placing holds) and the
// holds-sweep skill (expiring stale holds).
//
// IMPORTANT: This module must remain pure -- no I/O, no async, no imports
// from the DB or Nylas layers. It operates only on plain values so it can be
// tested without mocks and imported by any layer that needs to identify holds.

// The metadata key that marks a Nylas event as a Curia hold.
// Stored as a string 'true' because Nylas metadata values must be strings.
export const CURIA_HOLD_KEY = 'curia-hold';

// ---------------------------------------------------------------------------
// buildHoldMetadata
// ---------------------------------------------------------------------------

/**
 * Build the Nylas metadata map to attach to a hold event.
 *
 * Always includes:
 *   - curia-hold: 'true'   — identifies the event as a Curia hold
 *   - created-at: ISO 8601 — when the hold was placed (for staleness checks)
 *
 * Optionally includes:
 *   - source-ref           — originating message ID or task ref (for traceability)
 *
 * @param opts.createdAtIso  ISO 8601 creation timestamp (e.g. new Date().toISOString())
 * @param opts.sourceRef     Optional originating ref (message ID, task ref, etc.)
 */
export function buildHoldMetadata(opts: {
  sourceRef?: string;
  createdAtIso: string;
}): Record<string, string> {
  const base: Record<string, string> = {
    [CURIA_HOLD_KEY]: 'true',
    'created-at': opts.createdAtIso,
  };
  // Only include source-ref when provided -- keeps the metadata map minimal
  if (opts.sourceRef) {
    base['source-ref'] = opts.sourceRef;
  }
  return base;
}

// ---------------------------------------------------------------------------
// isHoldEvent
// ---------------------------------------------------------------------------

/**
 * Return true when a calendar event was placed by Curia as a hold.
 *
 * Checks for the sentinel metadata key 'curia-hold' === 'true'. Events
 * without metadata (new contacts' calendars, externally created events) always
 * return false, making this safe to call on any event shape.
 *
 * @param e  Any object with an optional metadata bag (matches NylasCalendarEvent shape)
 */
export function isHoldEvent(e: { metadata?: Record<string, string> | null }): boolean {
  // Use optional chaining so null/undefined metadata both fall through to false.
  return e.metadata?.[CURIA_HOLD_KEY] === 'true';
}

// ---------------------------------------------------------------------------
// eventsOverlap
// ---------------------------------------------------------------------------

/**
 * Return true when two half-open time intervals [aStart, aEnd) and [bStart, bEnd)
 * overlap -- that is, they share at least one instant.
 *
 * CRITICAL: touching edges do NOT constitute an overlap.
 *   - A slot ending at 11:00 and one starting at 11:00 are adjacent, not overlapping.
 *   - This matches calendar semantics: back-to-back meetings don't conflict.
 *
 * Uses strict inequalities: aStart < bEnd && aEnd > bStart.
 * All parameters are Unix seconds (integers or floats).
 *
 * @param aStart  Start of interval A (Unix seconds, inclusive)
 * @param aEnd    End of interval A (Unix seconds, exclusive)
 * @param bStart  Start of interval B (Unix seconds, inclusive)
 * @param bEnd    End of interval B (Unix seconds, exclusive)
 */
export function eventsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  // Standard open-interval overlap test.
  // Equivalent to: NOT (A ends before B starts OR B ends before A starts).
  return aStart < bEnd && aEnd > bStart;
}

// ---------------------------------------------------------------------------
// isHoldStale
// ---------------------------------------------------------------------------

/**
 * Return true when a hold event should be swept (deleted) because it is no
 * longer useful.
 *
 * A hold is stale when EITHER of these conditions is true:
 *   1. The slot has already ended (endTime <= nowUnix) — there's nothing to
 *      protect anymore; a real event either booked it or the slot lapsed.
 *   2. The hold was placed more than maxAgeMs milliseconds ago — a hold that
 *      lingers for days suggests the corresponding offer was never accepted and
 *      the slot should be freed.
 *
 * If the created-at timestamp is missing from metadata (corrupt or legacy hold),
 * we cannot verify freshness and treat the hold conservatively as stale so the
 * sweep removes it.
 *
 * @param e          Event object with endTime (Unix seconds) and optional metadata
 * @param nowUnix    Current time as Unix seconds (injectable for testing)
 * @param maxAgeMs   Maximum age in milliseconds before the hold is swept
 */
export function isHoldStale(
  e: { endTime: number | null; metadata?: Record<string, string> | null },
  nowUnix: number,
  maxAgeMs: number,
): boolean {
  // Condition 1: slot end is in the past (or null -- treat null as stale)
  if (e.endTime === null || e.endTime <= nowUnix) {
    return true;
  }

  // Condition 2: hold age exceeds the cap
  const createdAtStr = e.metadata?.['created-at'];
  if (!createdAtStr) {
    // Cannot determine age -- treat conservatively as stale
    return true;
  }
  const createdAtMs = new Date(createdAtStr).getTime();
  if (isNaN(createdAtMs)) {
    // Unparseable timestamp -- treat as stale
    return true;
  }
  const ageMs = nowUnix * 1000 - createdAtMs;
  // Stale only when age is STRICTLY greater than the cap.
  // A hold created exactly maxAgeMs ago is still within budget.
  return ageMs > maxAgeMs;
}
