// approval-trigger.ts — ApprovalTriggerService.
//
// Owns the approval request flow when the autonomy gate blocks a skill:
// dedup check, row insertion, short_ref generation, description building,
// and CEO notification. See ADR-018 and issue #427.

import type { ActionLogRepo } from './action-log-repo.js';
import type { OutboundGateway } from '../skills/outbound-gateway.js';
import type { Logger } from '../logger.js';
import { sanitizeOutput } from '../skills/sanitize.js';

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
    // outboundGateway is optional — row creation does not depend on the outbound stack.
    // If absent, notification is skipped (same as when ceoEmail is not configured).
    private readonly outboundGateway: OutboundGateway | undefined,
    private readonly logger: Logger,
    private readonly ceoEmail?: string,
  ) {}

  /**
   * Trigger an approval request when an autonomy gate blocks a skill.
   *
   * Steps:
   *   1. Dedup — check for existing pending_approval row with same skill + payload in same task
   *   2. Generate short_ref and description
   *   3. Insert autonomy_action_log row
   *   4. Notify CEO (best-effort — failure does not prevent row creation)
   *
   * Returns the result so the execution layer can enrich the advisory error message.
   */
  async request(opts: {
    taskId: string;
    conversationId?: string;
    skillName: string;
    actionRisk: string;
    input: Record<string, unknown>;
    currentScore: number;
    requiredScore: number;
  }): Promise<ApprovalRequestResult> {
    const { taskId, conversationId, skillName, actionRisk, input, currentScore, requiredScore } = opts;

    // Step 1: Dedup check
    const existing = await this.actionLogRepo.findPendingByTaskAndSkill(taskId, skillName, input);
    if (existing) {
      const existingShortRef = existing.shortRef ?? 'unknown';
      if (!existing.shortRef) {
        // A pending_approval row without a short_ref should not happen — flag it.
        this.logger.warn(
          { taskId, skillName },
          'approval-trigger: existing pending_approval row has null short_ref — data inconsistency',
        );
      }
      this.logger.info(
        { taskId, skillName, existingShortRef },
        'approval-trigger: duplicate request — pending_approval row already exists',
      );
      return { created: false, reason: 'duplicate', existingShortRef };
    }

    // Step 2: Generate short_ref and description.
    // Sanitize description before storing and sending — the input fields come from
    // LLM-generated skill arguments and may contain dangerous tags.
    const counter = await this.actionLogRepo.countShortRefsForTask(taskId);
    const shortRef = `${shortRefPrefix(skillName)}-${counter + 1}`;
    const description = sanitizeOutput(buildDescription(skillName, input));

    // Step 3: Insert row
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h from now
    const rowId = await this.actionLogRepo.insert({
      taskId,
      conversationId,
      skillName,
      actionRisk,
      outcome: 'pending_approval',
      payload: input,
      expiresAt,
      shortRef,
      description,
    });

    this.logger.info(
      { rowId, taskId, skillName, shortRef, currentScore, requiredScore },
      'approval-trigger: pending_approval row created',
    );

    // Step 4: Notify CEO (best-effort).
    // sendNotification() catches publish errors internally and returns false rather than
    // throwing, so we check the return value to know whether to stamp notification_sent_at.
    let notificationSent = false;
    if (this.ceoEmail && this.outboundGateway) {
      const sent = await this.outboundGateway.sendNotification({
        notificationType: 'approval_requested',
        ceoEmail: this.ceoEmail,
        subject: `Approval needed — ${description}`,
        body:
          `Curia wanted to ${description.charAt(0).toLowerCase() + description.slice(1)}, ` +
          `but the autonomy score (${currentScore}) is below the required threshold (${requiredScore}).\n\n` +
          `Reference: ${shortRef}\n` +
          `Expires: ${expiresAt.toISOString()}\n\n` +
          `Reply to approve, deny, or dismiss this request.`,
      });
      if (sent) {
        await this.actionLogRepo.setNotificationSentAt(rowId);
        notificationSent = true;
        this.logger.info({ rowId, shortRef }, 'approval-trigger: CEO notification sent');
      } else {
        this.logger.warn(
          { rowId, shortRef },
          'approval-trigger: CEO notification failed — row exists, CEO will see it in digest',
        );
      }
    } else {
      this.logger.warn(
        { rowId, shortRef },
        'approval-trigger: ceoEmail not configured — skipping notification',
      );
    }

    return { created: true, shortRef, notificationSent };
  }
}
