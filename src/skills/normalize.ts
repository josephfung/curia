// normalize.ts — input key normalization for skill handlers.
//
// LLMs call skills via tool_use with JSON objects. When a skill's input schema
// defines a parameter as a bare "object" (no nested properties), the LLM has
// no schema guidance for the inner key names and may emit either camelCase or
// snake_case. This utility normalizes keys to snake_case so handlers can rely
// on a single convention.
//
// Parallel to sanitize.ts (which normalizes *output*), this normalizes *input*.

/**
 * Shallow-convert camelCase keys to snake_case.
 *
 * When both the camelCase and snake_case forms of a key are present
 * (e.g. `{ signOff: "a", sign_off: "b" }`), the snake_case value wins —
 * it is the canonical form matching the YAML/manifest convention.
 *
 * Only converts top-level keys. Nested objects are left as-is (callers
 * can apply recursively if needed, but current skills only need one level).
 */
export function normalizeKeysToSnakeCase(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);

  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
    const isAlreadySnakeCase = snakeKey === key;

    // snake_case keys always take precedence — if a snake_case key was
    // already set by itself (or will be), don't let a camelCase variant
    // overwrite it.
    if (isAlreadySnakeCase || !Object.hasOwn(result, snakeKey)) {
      result[snakeKey] = value;
    }
  }

  return result;
}
