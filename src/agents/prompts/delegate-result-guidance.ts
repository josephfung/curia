// What to do with a `needs_clarification` or `paused` delegate result (#1959).
//
// This used to be two sections of the coordinator prompt, read on every turn and hundreds
// of lines away from the result it described. The delegate skill now returns it as the
// result's `next_step`, the same field the in-flight refusal uses (#1958), so it arrives
// exactly when it applies, for any agent that delegates.
//
// Hard-wrapped so prompt-exfiltration marker extraction (one marker per line) covers it.
// Joined with spaces for the tool result.

/** A specialist stopped to ask the principal something (`needs_clarification: true`). */
export const CLARIFICATION_NEXT_STEP_LINES: readonly string[] = [
  'The specialist paused mid-task and needs the principal\'s judgment to continue.',
  'Route `question` to the principal, framed naturally with `context` as background: on the',
  'channel the principal used for this request, or, on a scheduled turn with no originating',
  'channel, proactively on Signal, SMS, Slack, or email.',
  'On that outbound send call (signal-send, sms-send, slack-send, email-send), pass',
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

export const CLARIFICATION_NEXT_STEP = CLARIFICATION_NEXT_STEP_LINES.join(' ');
export const PAUSED_NEXT_STEP = PAUSED_NEXT_STEP_LINES.join(' ');
