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
 * Parse a 1:1 send skill's single recipient: the `recipient` reference field.
 * A retired raw-address sibling (`rawKey`) fails closed — it is not a recipient
 * the carve-out may treat as the principal (#2041). Null when the reference is
 * absent or not a string.
 */
export function parseOneRecipient(input: Record<string, unknown>, rawKey: string): string[] | null {
  if (hasPresentValue(input[rawKey])) return null;
  const reference = input['recipient'];
  if (reference !== undefined && reference !== null && typeof reference !== 'string') return null;
  if (!hasPresentValue(reference)) return null;
  return [(reference as string).trim()];
}
