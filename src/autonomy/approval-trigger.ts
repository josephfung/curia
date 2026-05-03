// approval-trigger.ts — ApprovalTriggerService.
//
// Owns the approval request flow when the autonomy gate blocks a skill:
// dedup check, row insertion, short_ref generation, description building,
// and CEO notification. See ADR-018 and issue #427.

import type { ActionLogRepo } from './action-log-repo.js';
import type { OutboundGateway } from '../skills/outbound-gateway.js';
import type { Logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ApprovalRequestResult =
  | { created: true; shortRef: string; notificationSent: boolean }
  | { created: false; reason: 'duplicate'; existingShortRef: string };

// ---------------------------------------------------------------------------
// Pure helpers — exported for testing
// ---------------------------------------------------------------------------

/** Skill name prefix mapping for short_ref generation. */
const PREFIX_RULES: Array<{ test: (name: string) => boolean; prefix: string }> = [
  { test: (n) => n.startsWith('calendar-'), prefix: 'cal' },
  { test: (n) => n.startsWith('email-'), prefix: 'email' },
  { test: (n) => n.startsWith('signal-'), prefix: 'signal' },
  { test: (n) => n === 'store-fact' || n.includes('-memory-'), prefix: 'mem' },
  { test: (n) => n.includes('contact'), prefix: 'contact' },
  { test: (n) => n.startsWith('schedule-'), prefix: 'sched' },
];

/** Return a short prefix for a skill name (e.g. "cal", "email"). */
export function shortRefPrefix(skillName: string): string {
  for (const rule of PREFIX_RULES) {
    if (rule.test(skillName)) return rule.prefix;
  }
  // Fallback: first word (before first hyphen), truncated to 6 chars
  const firstWord = skillName.split('-')[0] ?? skillName;
  return firstWord.slice(0, 6);
}

const MAX_VALUE_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 200;

/** Truncate a string to maxLen, appending "…" if truncated. */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}

/** Verb + label mapping for known skill name patterns. */
const VERB_RULES: Array<{ test: (name: string) => boolean; verb: string }> = [
  { test: (n) => n === 'calendar-create-event', verb: 'Create calendar event' },
  { test: (n) => n === 'calendar-update-event', verb: 'Update calendar event' },
  { test: (n) => n === 'calendar-delete-event', verb: 'Delete calendar event' },
  { test: (n) => n === 'email-reply', verb: 'Send email reply' },
  { test: (n) => n === 'email-draft-save', verb: 'Save email draft' },
  { test: (n) => n === 'store-fact', verb: 'Store fact' },
  { test: (n) => n.startsWith('signal-'), verb: 'Send Signal message' },
  { test: (n) => n.startsWith('schedule-'), verb: 'Schedule job' },
];

/**
 * Build a human-readable one-liner from skill name and input fields.
 * Used in CEO notifications, the pending-actions digest, and the
 * coordinator's advisory failure message.
 */
export function buildDescription(
  skillName: string,
  input: Record<string, unknown>,
): string {
  // Determine verb
  let verb = '';
  for (const rule of VERB_RULES) {
    if (rule.test(skillName)) { verb = rule.verb; break; }
  }
  if (!verb) return `Run ${skillName}`;

  // Pick context fields in priority order
  const contextParts: string[] = [];
  const fieldPriority = ['title', 'subject', 'to', 'label', 'name', 'query'];
  for (const field of fieldPriority) {
    const val = input[field];
    if (typeof val === 'string' && val.trim()) {
      contextParts.push(truncate(val.trim(), MAX_VALUE_LENGTH));
    }
  }

  // Known skill but no recognizable context fields — return just the verb.
  // (Fallback to "Run {skillName}" is only for truly unknown skills above.)
  if (contextParts.length === 0) return verb;

  const context = contextParts.join(', ');
  const full = `${verb}: ${context}`;
  return truncate(full, MAX_DESCRIPTION_LENGTH);
}

// ---------------------------------------------------------------------------
// Service class — request() added in Task 4
// ---------------------------------------------------------------------------

export class ApprovalTriggerService {
  constructor(
    private readonly actionLogRepo: ActionLogRepo,
    private readonly outboundGateway: OutboundGateway,
    private readonly logger: Logger,
    private readonly ceoEmail?: string,
  ) {}

  // request() is implemented in Task 4
}
