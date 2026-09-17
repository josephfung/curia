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
 * True when `value` is nothing but a `${...}` token — e.g. `"${principal_contact_id}"`.
 *
 * Deliberately anchored: a value that merely *contains* a token is a different (and much
 * rarer) authoring mistake, and rejecting substrings risks false positives on legitimate
 * free-text inputs such as a subject line quoting shell syntax.
 */
export function isUnresolvedPlaceholder(value: unknown): value is string {
  return typeof value === 'string' && /^\$\{.+\}$/.test(value.trim());
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
