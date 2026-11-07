// specialist-decline.ts — structured refusal for a delegated specialist task (#1871).
//
// A prose refusal looks like an answer, so the coordinator rewords the brief and
// retries until max_turns. This marker is the refusal channel: delegate returns
// it as data, and DelegationGuard stops further attempts to that specialist even
// when the next brief is worded differently.
//
// The decline also carries its facts as data (#2494), so the delegating agent relays
// them rather than a paraphrase that can contradict them: the cause, and any work the
// specialist finished before refusing.

/** Stable failure reason on the delegate result. Not the model's free-text attribute. */
export const SPECIALIST_DECLINE_REASON = 'specialist_decline';

/**
 * Tag on a decline's Curia-owned follow-up task (#2496). task-update moves a task
 * carrying it to the principal only with a question for them.
 */
export const SPECIALIST_DECLINE_TAG = 'specialist-decline';

/** Shown in the delegated-task system message so the format is harness-set. */
export const SPECIALIST_DECLINE_MARKER_EXAMPLE =
  '<specialist_decline reason="short_reason">why the task cannot be done</specialist_decline>';

/**
 * Why a specialist declined (#2494).
 * - `gate_refused`: a permission or approval check stopped a tool. The capability exists.
 * - `not_found`: what it was asked to act on does not exist.
 * - `capability_absent`: no tool it holds can do the step.
 * - `unspecified`: none of these was stated.
 */
export type DeclineCause = 'gate_refused' | 'not_found' | 'capability_absent' | 'unspecified';

const STATED_CAUSES: ReadonlySet<string> = new Set(['gate_refused', 'not_found', 'capability_absent']);

export function isDeclineCause(value: unknown): value is DeclineCause {
  return typeof value === 'string' && (STATED_CAUSES.has(value) || value === 'unspecified');
}

// The prompt tells the specialist to end the reply with the marker. A marker
// quoted earlier, with more answer after it, is not a refusal — otherwise a
// normal answer that mentions the format returns declined and the guard halts
// that specialist for the turn.
const MARKER_RE = /<specialist_decline\b([^>]*)>([\s\S]*?)<\/specialist_decline>\s*$/i;

// Room for a drafted outline or reply, well inside the execution layer's output cap.
const MAX_WORK_PRODUCT = 6000;

export interface SpecialistDeclineMarker {
  /** Model-supplied reason attribute, or the stable reason when the attribute is absent. */
  reason: string;
  message: string;
  /** The `cause` attribute when it names a known cause, else `unspecified`. */
  cause: DeclineCause;
  /**
   * The reply before the marker, when there is any: work the specialist finished before it
   * refused (a revised outline, a drafted reply). Dropping it lost that work (#2494).
   */
  workProduct?: string;
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
  const reasonAttr = attribute(attrs, 'reason');
  if (reasonAttr === 'short_reason') return null;
  const causeAttr = attribute(attrs, 'cause').toLowerCase();
  const before = Array.from(content.slice(0, match.index).trim()).slice(0, MAX_WORK_PRODUCT).join('');
  return {
    reason: reasonAttr.length > 0 ? reasonAttr.slice(0, 120) : SPECIALIST_DECLINE_REASON,
    message: body.slice(0, 2000),
    cause: STATED_CAUSES.has(causeAttr) ? (causeAttr as DeclineCause) : 'unspecified',
    ...(before.length > 0 && { workProduct: before }),
  };
}

function attribute(attrs: string, name: string): string {
  return (new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? '').trim();
}

/**
 * The decline's cause, code first (#2494). An access gate that refused one of the
 * specialist's calls is a permission refusal whatever the specialist wrote: in production
 * a gate refusal reached the principal as "no such capability". A stated `not_found` is
 * kept: the gated call may have been a side step, and the missing target is what the
 * principal has to hear. Otherwise the cause the specialist stated.
 */
export function resolveDeclineCause(stated: DeclineCause, gateRefusals: readonly string[] | undefined): DeclineCause {
  if (stated === 'not_found') return stated;
  if (gateRefusals !== undefined && gateRefusals.length > 0) return 'gate_refused';
  return stated;
}
