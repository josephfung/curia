// completion-claim.ts — spoken claims that something was done (#2428).
//
// On the first kick-off call the caller said "please send it" and the voice
// model answered "Done, boss" two seconds later with no tool call: nothing was
// sent. The runtime warns when a turn with no tool call makes one of these
// claims. A prod signal, not a filter, like spoken-jargon.ts.
//
// Narrow on purpose: openers and first-person past tense that report an action,
// not every "done" or "sent" in ordinary speech.

const COMPLETION_CLAIM =
  /(?:^|[.!?]\s+)(?:done|all set|all done|sent)\b|\b(?:i've|i have|i just)\s+(?:sent|booked|scheduled|set up|created|added|queued|messaged|emailed|texted|cancelled|canceled|moved)\b|(?:^|[.!?,]\s+)(?:it's|that's|it is|that is)\s+(?:sent|booked|done|scheduled|set up)\b/i;

/** The first completion claim in `text`, lowercased, or null. */
export function findCompletionClaim(text: string): string | null {
  const match = COMPLETION_CLAIM.exec(text.trim());
  return match ? match[0].replace(/^[.!?,\s]+/, '').toLowerCase() : null;
}
