// suggest-name.ts — pure helpers for the wizard's LLM name-suggestion feature
// (issue #799). The HTTP route in setup.ts calls the LLM and delegates the
// free-text → validated-name decision to parseSuggestedFirstName below, which
// is the only part that needs unit coverage.

// The instruction sent to the LLM. Deliberately tight: a single bare word makes
// the parse below succeed in the common case, and any deviation simply falls
// back to the static placeholder client-side (no error surfaced to the user).
export const SUGGEST_NAME_PROMPT =
  'Suggest a single, friendly, professional first name for an AI executive assistant. ' +
  'Respond with ONLY the first name: one word, letters only, no punctuation, quotes, or explanation.';

// Plausibility bounds for a first name. The lower bound rejects a bare initial
// ("A"); the upper bound rejects a run-on token that is clearly not a name.
const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 20;

// Single token of Unicode letters only — no whitespace (rejects multi-word),
// no digits, no punctuation/quotes. \p{L} keeps accented and non-Latin names
// valid (e.g. "Renée") while still rejecting anything the model wraps around it.
const SINGLE_NAME_PATTERN = /^\p{L}+$/u;

/**
 * Validate and normalise an LLM-suggested assistant first name.
 *
 * Returns the cleaned first name (first letter capitalised, the rest left as-is
 * so internal capitals like "McKenzie" survive) when the model returned exactly
 * one plausible letters-only token; returns null otherwise so the caller can
 * fall back to the static placeholder. Strict by design — issue #799 says to
 * reject anything that isn't a clean single name rather than try to salvage it.
 */
export function parseSuggestedFirstName(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length < MIN_NAME_LENGTH || trimmed.length > MAX_NAME_LENGTH) {
    return null;
  }
  if (!SINGLE_NAME_PATTERN.test(trimmed)) {
    return null;
  }
  // Capitalise the first letter so a lowercase model response ("sam") renders
  // as a proper name; slice() preserves any internal capitalisation.
  return trimmed[0]!.toUpperCase() + trimmed.slice(1);
}
