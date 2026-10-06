// Every piece of trigger guidance the platform injects outside the system prompt (#1959).
//
// Outbound prompt-exfiltration markers used to come only from the coordinator's
// `system_prompt`. Text moved out of it into injected blocks and tool results would stop
// being scanned, so a model echoing it to an outside sender would go undetected. Add any
// new trigger guidance here, and to the source list in
// tests/unit/agents/prompts/trigger-guidance.test.ts, which checks each one yields markers.

import { BULLPEN_REPLY_RULE } from './bullpen-reply-rule.js';
import { DAILY_DEBRIEF_RECAP_LINES, WEEKLY_DEBRIEF_RECAP_LINES } from './debrief-recap-instruction.js';
import { CLARIFICATION_NEXT_STEP_LINES, PAUSED_NEXT_STEP_LINES } from './delegate-result-guidance.js';
import { TURN_GUIDANCE_TEXTS } from './turn-guidance.js';

/** Newline-joined guidance texts, one marker per line once extracted. */
export const TRIGGER_GUIDANCE_MARKER_SOURCES: readonly string[] = [
  ...TURN_GUIDANCE_TEXTS,
  CLARIFICATION_NEXT_STEP_LINES.join('\n'),
  PAUSED_NEXT_STEP_LINES.join('\n'),
  BULLPEN_REPLY_RULE,
  DAILY_DEBRIEF_RECAP_LINES.join('\n'),
  WEEKLY_DEBRIEF_RECAP_LINES.join('\n'),
];
