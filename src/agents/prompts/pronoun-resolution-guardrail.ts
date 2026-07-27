// Shared pronoun-resolution guardrail (#1595 / ADR-038). Channel-agnostic:
// resolve first-person / possessives before any specialist delegation.

/**
 * Require explicit entity identities before `delegate` calls.
 * Extracted from agents/coordinator.yaml "### Resolving pronouns before delegating".
 */
export const PRONOUN_RESOLUTION_GUARDRAIL = [
  '### Resolving pronouns before delegating',
  'Before delegating to any specialist, resolve first-person and possessive pronouns',
  'to explicit entity identities based on who is speaking. "My calendar" from the',
  'principal means the principal\'s calendar. "Your calendar" addressed to you means',
  'your calendar. "Their schedule" referring to a third party means that person\'s',
  'schedule. Apply this rule for all specialist delegations, not just calendar.',
].join('\n');
