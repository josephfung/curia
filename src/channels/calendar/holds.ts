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

const HOLD_TITLE_PREFIX_RE = /^hold\s*\(tbc\)\s*:\s*/i;
const REPLY_PREFIX_RE = /^(re|fw|fwd)\s*:\s*/i;
const METADATA_VALUE_MAX = 1024;

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
  threadRef?: string;
  subject?: string;
  contactId?: string;
  contactDomain?: string;
  createdAtIso: string;
}): Record<string, string> {
  const base: Record<string, string> = {
    [CURIA_HOLD_KEY]: 'true',
    'created-at': opts.createdAtIso,
  };
  // Only include source-ref when provided -- keeps the metadata map minimal
  if (opts.sourceRef) {
    base['source-ref'] = sanitizeMetadataValue(opts.sourceRef);
  }
  if (opts.threadRef) {
    base['thread-ref'] = sanitizeMetadataValue(opts.threadRef);
  }
  if (opts.subject) {
    base.subject = sanitizeMetadataValue(opts.subject);
  }
  if (opts.contactId) {
    base['contact-id'] = sanitizeMetadataValue(opts.contactId);
  }
  const contactDomain = normalizeContactDomain(opts.contactDomain);
  if (contactDomain) {
    base['contact-domain'] = contactDomain;
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

export interface HoldMatchCriteria {
  subject?: string;
  contactDomain?: string;
  contactId?: string;
  sourceRef?: string;
  threadRef?: string;
  startTime?: number;
  endTime?: number;
}

export interface HoldMatchResult<T> {
  hold: T;
  score: number;
  reasons: string[];
}

export interface HoldLike {
  title?: string;
  startTime: number | null;
  endTime: number | null;
  metadata?: Record<string, string> | null;
}

export function normalizeContactDomain(value?: string): string | null {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return null;
  const domain = trimmed.includes('@') ? trimmed.split('@').pop() : trimmed;
  if (!domain) return null;
  const normalized = domain.replace(/^mailto:/, '').replace(/^[\s.]+|[\s.]+$/g, '');
  return normalized.includes('.') ? normalized : null;
}

export function normalizeSchedulingSubject(subject?: string): string {
  let normalized = subject?.trim().toLowerCase() ?? '';
  while (REPLY_PREFIX_RE.test(normalized)) {
    normalized = normalized.replace(REPLY_PREFIX_RE, '');
  }
  normalized = normalized.replace(HOLD_TITLE_PREFIX_RE, '');
  return normalized
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchHoldCandidate<T extends HoldLike>(
  hold: T,
  criteria: HoldMatchCriteria,
): HoldMatchResult<T> | null {
  if (!isHoldEvent(hold)) return null;

  const reasons: string[] = [];
  let score = 0;

  const exactSourceRef = metadataEquals(hold, 'source-ref', criteria.sourceRef);
  const exactThreadRef = metadataEquals(hold, 'thread-ref', criteria.threadRef);
  if (exactSourceRef) {
    score += 100;
    reasons.push('source-ref');
  }
  if (exactThreadRef) {
    score += 70;
    reasons.push('thread-ref');
  }

  const requestedDomain = normalizeContactDomain(criteria.contactDomain);
  const holdDomain = normalizeContactDomain(hold.metadata?.['contact-domain']);
  if (requestedDomain && holdDomain) {
    if (requestedDomain === holdDomain) {
      score += 45;
      reasons.push('contact-domain');
    } else if (!exactSourceRef && !exactThreadRef) {
      return null;
    }
  }

  if (criteria.contactId && hold.metadata?.['contact-id'] === criteria.contactId) {
    score += 40;
    reasons.push('contact-id');
  }

  const requestedSubject = normalizeSchedulingSubject(criteria.subject);
  const holdSubject = normalizeSchedulingSubject(hold.metadata?.subject ?? hold.title);
  if (requestedSubject && holdSubject) {
    if (requestedSubject === holdSubject) {
      score += 45;
      reasons.push('subject-exact');
    } else if (requestedSubject.includes(holdSubject) || holdSubject.includes(requestedSubject)) {
      score += 38;
      reasons.push('subject-contained');
    } else {
      const similarity = tokenSimilarity(requestedSubject, holdSubject);
      if (similarity >= 0.5) {
        score += Math.round(similarity * 35);
        reasons.push(`subject-similar:${similarity.toFixed(2)}`);
      }
    }
  }

  if (
    typeof criteria.startTime === 'number' &&
    typeof criteria.endTime === 'number' &&
    hold.startTime !== null &&
    hold.endTime !== null &&
    eventsOverlap(criteria.startTime, criteria.endTime, hold.startTime, hold.endTime)
  ) {
    score += 20;
    reasons.push('time-overlap');
  }

  return score > 0 ? { hold, score, reasons } : null;
}

export function findMatchingHolds<T extends HoldLike>(
  events: T[],
  criteria: HoldMatchCriteria,
  minScore = 75,
): Array<HoldMatchResult<T>> {
  return events
    .map((event) => matchHoldCandidate(event, criteria))
    .filter((match): match is HoldMatchResult<T> => match !== null && match.score >= minScore)
    .sort((a, b) => b.score - a.score);
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

function metadataEquals(e: { metadata?: Record<string, string> | null }, key: string, value?: string): boolean {
  return Boolean(value && e.metadata?.[key] === value);
}

function sanitizeMetadataValue(value: string): string {
  return value.trim().slice(0, METADATA_VALUE_MAX);
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = new Set(left.split(' ').filter(Boolean));
  const rightTokens = new Set(right.split(' ').filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection++;
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
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
