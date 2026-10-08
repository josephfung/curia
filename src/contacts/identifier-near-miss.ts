// identifier-near-miss.ts — is a new channel identifier a likely mistyping of one
// already on file? (#2041)
//
// contact-create and contact-link-identity run this before an agent-entered address
// is stored. A hit is not a refusal on its own: the agent is shown the contact it
// resembles and decides (distinct_from). The bounds catch the ADR-047 incidents —
// `.com` for `.ca` is distance 2, an inserted dot distance 1 — while two short
// addresses at one domain (al@x.io, ed@x.io) stay apart.
//
// Slack and Telegram ids are opaque: one character different is a different
// account, not a typo worth flagging. They are only ever matched exactly.

/** Channels whose identifiers are phone numbers. A number is compared across all of them. */
export const PHONE_CHANNELS: ReadonlySet<string> = new Set(['phone', 'signal', 'sms']);

/** Email addresses shorter than this tolerate one edit, not two. */
const SHORT_EMAIL_CHARS = 12;

export type IdentifierFamily = 'email' | 'phone' | 'opaque';

export function identifierFamily(channel: string): IdentifierFamily {
  if (channel === 'email') return 'email';
  if (PHONE_CHANNELS.has(channel)) return 'phone';
  return 'opaque';
}

/** The channels an identifier on `channel` is compared against for duplicates. */
export function comparableChannels(channel: string): string[] {
  return identifierFamily(channel) === 'phone' ? [...PHONE_CHANNELS] : [channel];
}

/** Digits only, so `+1 (416) 555-0100` and `+14165550100` compare equal. */
export function phoneDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * Optimal string alignment distance: Levenshtein plus one adjacent transposition.
 * Returns `max + 1` when the length difference alone exceeds `max`, and never more
 * than `max + 1`, so callers compare against `max`.
 */
export function osaDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows = a.length + 1;
  const cols = b.length + 1;
  // d[i][j] is the distance between a's first i characters and b's first j.
  const d: number[][] = Array.from({ length: rows }, (_, i) => {
    const row = new Array<number>(cols).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j < cols; j++) d[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = value;
    }
  }
  return Math.min(d[rows - 1]![cols - 1]!, max + 1);
}

/**
 * True when `candidate` is within a typo of `existing` and not the same identifier.
 * Both must be in the same family (the caller compares within comparableChannels).
 * An identical identifier is an exact match, which the caller handles separately.
 */
export function isNearMiss(channel: string, candidate: string, existing: string): boolean {
  const family = identifierFamily(channel);
  if (family === 'email') {
    const a = candidate.toLowerCase();
    const b = existing.toLowerCase();
    if (a === b) return false;
    const max = Math.min(a.length, b.length) < SHORT_EMAIL_CHARS ? 1 : 2;
    return osaDistance(a, b, max) <= max;
  }
  if (family === 'phone') {
    const a = phoneDigits(candidate);
    const b = phoneDigits(existing);
    if (a.length === 0 || b.length === 0 || a === b) return false;
    return osaDistance(a, b, 1) <= 1;
  }
  return false;
}

/** The same identifier for duplicate purposes: email ignoring case, numbers by digits, the rest exactly. */
export function sameIdentifier(channel: string, a: string, b: string): boolean {
  const family = identifierFamily(channel);
  if (family === 'email') return a.toLowerCase() === b.toLowerCase();
  if (family === 'phone') {
    const digits = phoneDigits(a);
    return digits.length > 0 && digits === phoneDigits(b);
  }
  return a === b;
}
