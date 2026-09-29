// escape-regexp.ts — the one regex-literal escape for the whole codebase.
//
// Before this module the same character class was declared four times: a named
// helper in channels/slack/slack-entities.ts, two inline copies in
// agents/agent-display-name.ts, and one in skills/_shared/voice-learn-logic.ts.
// All four agreed, so nothing was broken — but a fifth caller writing the class
// from memory is how they stop agreeing, and the failure is silent: a narrowed
// class mis-escapes rather than throwing. CodeQL already caught exactly that
// drift in a test (js/incomplete-sanitization, code-scanning alert 284: an
// escape covering dots but not backslashes).
//
// The class below is the full ECMAScript set of characters that are meaningful
// outside a character class, plus the backslash itself. Order matters only in
// that `\]` must be escaped inside the class and `\\` must come last.
//
// `$&` in the replacement is the matched character, and the pattern is `g`, so
// every occurrence is escaped rather than just the first — the two mistakes the
// CodeQL rule exists to catch.
//
// Escaping a literal is the fallback, not the goal. Where the dynamic part can
// be kept out of the pattern entirely — a substring comparison, an anchored
// equality check — prefer that; there is then nothing to escape.

/**
 * Escape `value` so it matches itself literally inside a `RegExp`.
 *
 * Safe for any input, including strings that are not valid regex on their own
 * (`'('` compiles to a SyntaxError raw, and to a literal paren once escaped).
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
