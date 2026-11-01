// spoken-jargon.ts — words that name Curia's internals and should never be
// heard on a call (#2379). The voice model repeated them from its prompt and
// tool descriptions: "I'll ask the calendar specialist", "I'll hand that off
// to the coordinator with an async offramp".
//
// Used two ways: the runtime warns when a spoken sentence contains one (a prod
// signal, not a filter), and unit tests hold voice-visible prompt and tool text
// to it: no quoted example carries a term, and no "never say …" sentence names
// one, since the model repeated exactly those words.
//
// Narrow on purpose: the phrases heard on the call, not words executives use
// ("I'll delegate that to Maya", "see a specialist"). A warning that fires on
// ordinary speech would be ignored, and then a clean log would mean nothing.

const INTERNAL_TERMS =
  /\b(?:(?:calendar|contacts?|research|inbox|ceo-inbox|social-media)\s+specialists?|coordinator|off-?ramps?|sub-?agents?|delegate\s+tool)\b/gi;

/** The internal terms in `text`, lowercased, in order of appearance (with repeats). */
export function findInternalJargon(text: string): string[] {
  return [...text.matchAll(INTERNAL_TERMS)].map(match => match[0].toLowerCase());
}
