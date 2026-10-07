/**
 * Recursively strip null bytes (U+0000) from all string values in a value.
 *
 * PostgreSQL cannot store U+0000 in text or JSONB columns — it rejects the
 * write with error 22P05 ("unsupported Unicode escape sequence"). Skill
 * payloads and archived LLM content can carry null bytes when a fetched page
 * or a model response contains binary or mixed-encoding text. Callers strip
 * at the audit write paths (`audit_log` payload and `llm_call_archive`).
 *
 * Null bytes are replaced with '' rather than a placeholder so payloads stay
 * clean for downstream consumers. The loss of the byte is acceptable — these
 * rows are diagnostic records, not faithful binary stores.
 *
 * Only plain objects are walked. Non-plain objects (Date, Buffer, RegExp)
 * pass through untouched — Object.entries() on a Date returns [] which would
 * silently replace the Date with {}, corrupting timestamp fields.
 * JSON.stringify handles those on its own (e.g. Date.toISOString()).
 */
export function stripNullBytes(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\u0000/g, '');
  }
  if (Array.isArray(value)) {
    return value.map(stripNullBytes);
  }
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, stripNullBytes(v)]),
    );
  }
  return value;
}
