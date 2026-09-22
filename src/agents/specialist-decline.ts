// specialist-decline.ts — structured refusal for a delegated specialist task (#1871).
//
// A prose refusal looks like an answer, so the coordinator rewords the brief and
// retries until max_turns. This marker is the refusal channel: delegate returns
// it as data, and DelegationGuard stops further attempts to that specialist even
// when the next brief is worded differently.

/** Stable failure reason on the delegate result. Not the model's free-text attribute. */
export const SPECIALIST_DECLINE_REASON = 'specialist_decline';

/** Shown in the delegated-task system message so the format is harness-set. */
export const SPECIALIST_DECLINE_MARKER_EXAMPLE =
  '<specialist_decline reason="short_reason">why the task cannot be done</specialist_decline>';

// The prompt tells the specialist to end the reply with the marker. A marker
// quoted earlier, with more answer after it, is not a refusal — otherwise a
// normal answer that mentions the format returns declined and the guard halts
// that specialist for the turn.
const MARKER_RE = /<specialist_decline\b([^>]*)>([\s\S]*?)<\/specialist_decline>\s*$/i;

export interface SpecialistDeclineMarker {
  /** Model-supplied reason attribute, or the stable reason when the attribute is absent. */
  reason: string;
  message: string;
}

/**
 * Parse a specialist refusal marker out of a response body.
 *
 * Returns null for ordinary prose, for an empty body, for a verbatim echo of
 * the harness example (a copied template is not a refusal), and when the marker
 * is not the end of the reply.
 */
export function parseSpecialistDeclineMarker(content: string): SpecialistDeclineMarker | null {
  const match = MARKER_RE.exec(content);
  if (!match) return null;
  const body = (match[2] ?? '').trim();
  if (body.length === 0) return null;
  // The system message includes the template. Echoing it unchanged is not a refusal.
  if (body === 'why the task cannot be done') return null;
  const attrs = match[1] ?? '';
  const reasonMatch = /\breason="([^"]*)"/.exec(attrs);
  const reasonAttr = (reasonMatch?.[1] ?? '').trim();
  if (reasonAttr === 'short_reason') return null;
  return {
    reason: reasonAttr.length > 0 ? reasonAttr.slice(0, 120) : SPECIALIST_DECLINE_REASON,
    message: body.slice(0, 2000),
  };
}
