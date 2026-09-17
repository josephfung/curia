/**
 * Guard against unresolved `${...}` runtime template tokens arriving as skill inputs.
 *
 * Agent system prompts are interpolated by `interpolateRuntimeContext()`
 * (src/agents/loader.ts) and scheduled-job payloads by the scheduler, so by the time a
 * model sees either, tokens like `${principal_contact_id}` are already real values. A
 * model that instead copies the token *text* into a tool argument is telling us it read
 * the token from somewhere that was never interpolated — a tool description, a hand-
 * written job payload, an agent without the placeholder in its prompt at all (#1800).
 *
 * The generic "not a UUID" rejection that used to catch this is technically correct but
 * unhelpful: it reads as a malformed ID and invites the model to retry with another
 * guess. Naming the actual failure lets it recover on the next turn instead.
 */

/**
 * The shape of a template token: `${`, at least one character, `}`.
 *
 * Every consumer derives its regex from this one source so the three enforcement points —
 * the input guard below, the scheduler's unresolved-token warning, and the manifest scan
 * in tests/unit/skills/manifest-placeholder-free.test.ts — cannot drift apart. They did:
 * the first accepted any token while the other two matched only `[a-z_]+`, so
 * `${principal_contact_id_2}` was rejected as an input but invisible to the scan meant to
 * stop it being written in the first place.
 *
 * Nothing about the token vocabulary is encoded here on purpose. The bug is that a model
 * copies anything token-shaped out of text it was never meant to read literally, and it
 * does that whether or not the name matches a placeholder the runtime actually defines.
 */
const TOKEN_SOURCE = String.raw`\$\{[^}]+\}`;

/**
 * True when `value` is nothing but a `${...}` token — e.g. `"${principal_contact_id}"`.
 *
 * Deliberately anchored: a value that merely *contains* a token is a different (and much
 * rarer) authoring mistake, and rejecting substrings risks false positives on legitimate
 * free-text inputs such as a subject line quoting shell syntax.
 */
export function isUnresolvedPlaceholder(value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^${TOKEN_SOURCE}$`).test(value.trim());
}

/**
 * Every distinct `${...}` token in `text`, in first-seen order.
 *
 * Unanchored, unlike `isUnresolvedPlaceholder`: this one is for scanning prose (a tool
 * description, a job payload) where a token is embedded in a sentence rather than standing
 * alone as a value.
 *
 * The regex is constructed per call rather than shared at module scope so no caller can
 * inherit another's `lastIndex` from the `g` flag.
 */
export function findTemplateTokens(text: string): string[] {
  return [...new Set(text.match(new RegExp(TOKEN_SOURCE, 'g')) ?? [])];
}

/**
 * Error message for a skill input that arrived as a literal template token.
 *
 * `field` is the input name as declared in tool.json, so the model can map the message
 * back to the argument it needs to fix.
 */
export function unresolvedPlaceholderError(field: string, value: string): string {
  return (
    `Unresolved template placeholder in "${field}": got the literal token ${value.trim()} ` +
    `instead of a value. Do not copy \${...} tokens out of tool descriptions — use the ` +
    `principal's contact ID as given in your system prompt.`
  );
}
