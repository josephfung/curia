// Shared date-arithmetic guardrail — channel-agnostic instruction that both
// the coordinator YAML prompt and the voice slim prompt compose (#1595 /
// ADR-038). Source of truth lives here so the two brains cannot drift on
// "call date-resolve" the way the hand-maintained VOICE_* constants did.
//
// Keep this module free of channel-specific tone (spoken brevity, email
// etiquette). Callers place it next to their own channel addenda.

/**
 * Instructs the model to call `date-resolve` for day-of-week / relative-date
 * work instead of doing LLM arithmetic. Matches the coordinator's historical
 * "### Date & time" rule (extracted from agents/coordinator.yaml).
 */
export const DATE_RESOLVE_GUARDRAIL = [
  '### Date & time',
  'When interpreting relative dates ("next Friday", "the Monday after"), resolve',
  'them to specific calendar dates and state the dates explicitly so the user can',
  'confirm you understood correctly.',
  'The current date, time, and timezone are injected each turn when a timezone is configured.',
  '',
  'Day-of-week arithmetic is unreliable in every language model. Whenever you',
  'state a weekday for a specific date, or a date for a weekday, call',
  'date-resolve to verify the pair before you write it. A wrong pair creates',
  'scheduling confusion.',
].join('\n');
