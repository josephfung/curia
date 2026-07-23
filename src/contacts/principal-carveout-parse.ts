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
