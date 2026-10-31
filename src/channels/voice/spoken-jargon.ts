// spoken-jargon.ts — words that name Curia's internals and should never be
// heard on a call (#2379). The voice model repeated them from its prompt and
// tool descriptions: "I'll ask the calendar specialist", "I'll hand that off
// to the coordinator with an async offramp".
//
// Used two ways: the runtime warns when a spoken sentence contains one (a prod
// signal, not a filter), and a unit test holds every quoted example in
// voice-visible prompt and tool text free of them, since the model copies
// examples closely.

const INTERNAL_TERMS = /\b(?:coordinator|specialists?|off-?ramps?|async|delegat(?:e|ed|es|ing|ion)|sub-?agents?)\b/gi;

/** The internal terms in `text`, lowercased, in order of appearance (with repeats). */
export function findInternalJargon(text: string): string[] {
  return [...text.matchAll(INTERNAL_TERMS)].map(match => match[0].toLowerCase());
}
