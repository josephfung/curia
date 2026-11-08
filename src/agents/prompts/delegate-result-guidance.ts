// What to do with a `needs_clarification` or `paused` delegate result (#1959).
//
// This used to be two sections of the coordinator prompt, read on every turn and hundreds
// of lines away from the result it described. The delegate skill now returns it as the
// result's `next_step`, the same field the in-flight refusal uses (#1958), so it arrives
// exactly when it applies, for any agent that delegates.
//
// Hard-wrapped so prompt-exfiltration marker extraction (one marker per line) covers it.
// Joined with spaces for the tool result.

import type { DeclineCause } from '../specialist-decline.js';

/** A specialist stopped to ask the principal something (`needs_clarification: true`). */
export const CLARIFICATION_NEXT_STEP_LINES: readonly string[] = [
  'The specialist paused mid-task and needs the principal\'s judgment to continue.',
  'Route `question` to the principal, framed naturally with `context` as background: on the',
  'channel the principal used for this request, or, on a scheduled turn with no originating',
  'channel, proactively by their usual channel (Reaching the principal).',
  'On that outbound send call (signal-send, sms-send, slack-send, email-send, web-send), pass',
  '`context_bridge` with this `resume_token` in its `metadata`, so the principal\'s answer',
  'routes back to this specialist. The bridge is a tool parameter: never put it or the token',
  'in the message body.',
];

/** A long resumable task hit its per-slice turn budget (`paused: true`). */
export const PAUSED_NEXT_STEP_LINES: readonly string[] = [
  'This is progress, not a failure: the specialist hit its per-slice turn budget on a long',
  'resumable task. Do not delegate this work again or retry it this turn; the platform',
  'schedules the next slice itself, and fails and escalates the task if it stops making',
  'progress. Record progress from `done`, `total` and `message`, and when the principal is',
  'waiting on a synchronous channel you may tell them it is still in progress (X of Y).',
  'Never attribute the pause to an external cause such as an API timeout or outage.',
];

/** The specialist's result carries composed email (`draft_emails`, #2055). */
export const DRAFT_EMAIL_NEXT_STEP_LINES: readonly string[] = [
  'The specialist composed the draft email in this result but did not send it, whatever',
  'its text says. If the principal asked for it to go out, send it yourself with',
  'email-send and report the send from that result. Otherwise tell the principal it is',
  'drafted and has not been sent.',
];

/** No email or message went out, and the result or brief talks about sending (#2055). */
export const NOTHING_SENT_NEXT_STEP_LINES: readonly string[] = [
  'No email or message went out in the specialist\'s task; any calendar invite or',
  'notification it did send is listed as sent. Text in the result that says an email or',
  'message was sent or is out describes something it wrote, not a delivery. If the',
  'principal asked for a send, do it yourself with email-send, or tell the principal it',
  'has not gone out.',
];

/**
 * A specialist declined with the structured marker (#1871, #2496). Rides on the decline
 * result, so it arrives exactly when the coordinator has to choose a fallback, and the
 * turn continues rather than ending in a review task. The runtime reopens one retry to
 * the declining specialist after another specialist's delegation succeeds.
 */
export const DECLINE_NEXT_STEP_LINES: readonly string[] = [
  'The specialist declined. `message` is its account, written to you: what it could not do,',
  'why, and any alternative it offered or finished. Before telling the principal it cannot',
  'be done, try in order: (1) the alternative it offered, if it serves the request; (2) the',
  'step yourself, if you hold the tool (for example email-send for a draft it could not',
  'send); (3) a specialist that can unblock it (for example contacts verifying or adding a',
  'recipient), after which one retry to this specialist is allowed. Ask the principal only',
  'when their input or authority is needed, with one specific question; never ask them to',
  're-scope, reassign or cancel. Report what was and was not done in your own words: do not',
  'quote `message`, and leave out the specialist and any tool, grant or ID it names.',
  '`sent` and a `gate_refused` cause are recorded by the platform; any other `cause` is the',
  'specialist\'s own account. Never report anything that contradicts them.',
];

/**
 * Added to the decline next step for the cause it names (#2494). Each corrects a
 * misreport seen in production: a permission refusal relayed as a missing capability,
 * and a missing draft relayed as one sitting in Drafts.
 */
export const DECLINE_CAUSE_NEXT_STEP_LINES: Readonly<Partial<Record<DeclineCause, readonly string[]>>> = {
  gate_refused: [
    'Cause: a permission or approval check refused the step, so it was not done. The',
    'capability exists: never say there is no way to do it. Say it was not done and that it',
    'needs the principal\'s direct go-ahead.',
  ],
  not_found: [
    'Cause: what it was asked to act on was not found. Say so; never describe it as existing,',
    'saved or waiting anywhere.',
  ],
};

/** Added to the decline next step when the specialist finished work before declining (#2494). */
export const DECLINE_WORK_PRODUCT_NEXT_STEP_LINES: readonly string[] = [
  '`work_product` is its text before the decline. If it holds finished work (a draft, an',
  'outline, a revision), give that to the principal or use it; do not drop it. Its tool,',
  'agent and ID names stay out of what you tell them.',
];

/** The next step for a decline with this cause, and with or without finished work. */
export function declineNextStep(cause: DeclineCause | undefined, hasWorkProduct: boolean): string {
  const causeLines = cause !== undefined && Object.hasOwn(DECLINE_CAUSE_NEXT_STEP_LINES, cause)
    ? DECLINE_CAUSE_NEXT_STEP_LINES[cause] ?? []
    : [];
  return [
    ...DECLINE_NEXT_STEP_LINES,
    ...causeLines,
    ...(hasWorkProduct ? DECLINE_WORK_PRODUCT_NEXT_STEP_LINES : []),
  ].join(' ');
}

/**
 * A delegation to a specialist that failed and may be retried: a retryable failure, or a
 * failed tool result. Keyed by agent id; only specialists whose failure has a known wrong
 * reading carry one. These were sentences in the coordinator prompt until prompt trim PR 6.
 *
 * Not for a decline (a refusal, not a failed lookup) or a timeout (the work may have
 * gone through, and the in-flight guard refuses a retry). Those, and every other
 * non-retryable failure, are escalated and answered by the failure narration (#1860).
 */
export const DELEGATE_FAILURE_NEXT_STEP_LINES: Readonly<Record<string, readonly string[]>> = {
  // An empty or failed read is not an empty calendar (#1854). Worded for writes too.
  calendar: [
    'The calendar request did not complete. Tell the principal what could not be done and',
    'why, in plain words. A read that failed is not an empty calendar: never present the day',
    'as clear or free.',
  ],
  // The guard escalates a second identical failure (MAX_RETRYABLE_IDENTICAL_DELEGATIONS);
  // a reworded brief is a new key, so the one retry is stated here too.
  contacts: [
    'The person could not be resolved. Tell the principal the lookup failed. If you have not',
    'retried it yet, try it once more; otherwise answer without delegating again. Act on that',
    'person only once you have their contact ID.',
  ],
};

/** The next step for a failed delegation to `agent`, or undefined when it has none. */
export function delegateFailureNextStep(agent: string): string | undefined {
  const lines = Object.hasOwn(DELEGATE_FAILURE_NEXT_STEP_LINES, agent)
    ? DELEGATE_FAILURE_NEXT_STEP_LINES[agent]
    : undefined;
  return lines ? lines.join(' ') : undefined;
}

export const CLARIFICATION_NEXT_STEP = CLARIFICATION_NEXT_STEP_LINES.join(' ');
export const PAUSED_NEXT_STEP = PAUSED_NEXT_STEP_LINES.join(' ');
export const DRAFT_EMAIL_NEXT_STEP = DRAFT_EMAIL_NEXT_STEP_LINES.join(' ');
export const NOTHING_SENT_NEXT_STEP = NOTHING_SENT_NEXT_STEP_LINES.join(' ');
export const DECLINE_NEXT_STEP = DECLINE_NEXT_STEP_LINES.join(' ');
