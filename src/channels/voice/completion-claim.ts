// completion-claim.ts — spoken claims that something was done (#2428).
//
// On the first kick-off call the caller said "please send it" and the voice
// model answered "Done, boss" two seconds later with no tool call: nothing was
// sent. The runtime warns when a turn with no tool call makes one of these
// claims. A prod signal, not a filter, like spoken-jargon.ts.
//
// Narrow on purpose: openers and first-person past tense that report an action.
// Questions, and states the model can read off the calendar ("that's booked for
// Thursday"), are not claims.

const CLAIM_OPENER = /^(?:done|all set|all done|sent)\b/i;
const CLAIM_FIRST_PERSON =
  /\b(?:i've|i have|i just)\s+(?:sent|booked|scheduled|set up|created|added|queued|messaged|emailed|texted|cancelled|canceled|moved)\b/i;
const CLAIM_RESULT = /^(?:it's|that's|it is|that is)\s+(?:sent|done)\b/i;

/** The first completion claim in `text`, lowercased, or null. */
export function findCompletionClaim(text: string): string | null {
  const sentences = text.trim().match(/[^.!?]+[.!?]*/g) ?? [];
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (sentence.endsWith('?')) continue;
    // A clause after a comma can open a claim too: "Okay, that's sent."
    const clauses = sentence.split(/,\s*/);
    for (const clause of clauses) {
      const match = CLAIM_OPENER.exec(clause) ?? CLAIM_RESULT.exec(clause) ?? CLAIM_FIRST_PERSON.exec(clause);
      if (match) return match[0].toLowerCase();
    }
  }
  return null;
}
