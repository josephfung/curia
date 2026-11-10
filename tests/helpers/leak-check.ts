// leak-check.ts — serialize published bus events for "the secret never appears" assertions.
//
// Every bus event carries a random `id` (UUID) and a `timestamp` from createEvent-style
// factories. A short digit sentinel ('456', '4111') turns up in those by chance (#2548), so a
// plain JSON.stringify check is flaky. This blanks only those two envelope fields, and only
// when they hold what the factory generates; everything else, payload included, is kept
// intact, so a sentinel anywhere a value could leak still fails the check.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isEnvelope(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && 'type' in value && 'payload' in value;
}

/** JSON of `value` with each bus event envelope's generated `id` and `timestamp` blanked. */
export function serializeForLeakCheck(value: unknown): string {
  return JSON.stringify(value, function (this: unknown, key, v: unknown) {
    if (!isEnvelope(this)) return v;
    if (key === 'id' && typeof v === 'string' && UUID.test(v)) return '<id>';
    // Date#toJSON has already run on `v`; the holder still has the Date itself.
    if (key === 'timestamp' && this[key] instanceof Date) return '<timestamp>';
    return v;
  });
}
