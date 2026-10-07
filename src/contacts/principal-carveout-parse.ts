// Shared helpers for Gate C carve-out skill-input parsers on channel principal-rules.

/** True when a skill-input value is present (non-empty string / non-empty array / other truthy). */
export function hasPresentValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** Split a comma-separated address list, trimming empties. */
export function splitCommaSeparatedAddresses(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Parse a 1:1 send skill's single recipient: the `recipient` reference field or
 * its raw-address sibling (#2033). Null when neither is present, when both are
 * (the skill refuses that), or when either is not a string — fail closed.
 */
export function parseOneRecipient(input: Record<string, unknown>, rawKey: string): string[] | null {
  const reference = input['recipient'];
  const raw = input[rawKey];
  for (const value of [reference, raw]) {
    if (value !== undefined && value !== null && typeof value !== 'string') return null;
  }
  const hasReference = hasPresentValue(reference);
  const hasRaw = hasPresentValue(raw);
  if (hasReference === hasRaw) return null;
  return [((hasReference ? reference : raw) as string).trim()];
}
