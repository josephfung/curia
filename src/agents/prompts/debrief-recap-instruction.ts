// End-of-day debrief recap steps (#1959).
//
// The setup wizard schedules the debrief as a coordinator job with intent anchor
// `daily_debrief` or `weekly_debrief`. The steps used to live in the coordinator's
// always-on prompt; the scheduler now adds them to that job's task content when it fires
// (see debriefRecapInstruction in src/scheduler/debrief-recap.ts), the same way task wakes
// carry WAKE_DISPOSITION_INSTRUCTION.
//
// Hard-wrapped so prompt-exfiltration marker extraction (one marker per line) covers it.

function recapLines(window: string): string[] {
  return [
    'This is an end-of-day debrief: a recap of work you already did, not a forward-looking',
    'digest.',
    `1. Call \`activity-log\` with \`since\` set to ${window}. Optionally pass`,
    '   `tool_name: "calendar-respond-to-invite"` to focus on auto-RSVPs.',
    '2. Call `list-pending-actions` for anything still awaiting the principal\'s approval.',
    '3. Compose a concise recap. Lead with autonomous actions (RSVPs sent, emails drafted or',
    '   sent, calendar changes) from activity-log\'s `target`, `outcome` and `detail` fields,',
    '   noting `autonomy: approved` vs `autonomous` where present. Follow with pending approvals.',
    '4. Deliver it to the principal on Signal or email. Skip sending when both calls return',
    '   empty.',
  ];
}

export const DAILY_DEBRIEF_RECAP_LINES: readonly string[] = recapLines('the start of the current local day');
export const WEEKLY_DEBRIEF_RECAP_LINES: readonly string[] = recapLines('7 days ago');

// Newline-joined: the numbered steps stay readable inside the JSON task content.
export const DAILY_DEBRIEF_RECAP_INSTRUCTION = DAILY_DEBRIEF_RECAP_LINES.join('\n');
export const WEEKLY_DEBRIEF_RECAP_INSTRUCTION = WEEKLY_DEBRIEF_RECAP_LINES.join('\n');
