// approval-trigger.ts — ApprovalTriggerService.
//
// Owns the approval request flow when the autonomy gate blocks a skill:
// dedup check, row insertion, short_ref generation, description building,
// and CEO notification. See ADR-018 and issue #427.

import { randomBytes } from 'node:crypto';
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

/**
 * Generate a globally unique short_ref for an approval action.
 * Returns 8 lowercase hex chars (4 random bytes), giving ~4 billion possibilities.
 * Replaces the previous per-task sequential prefix scheme (e.g. "email-1") which
 * caused collisions across tasks — two unrelated emails both received "email-1".
 */
export function generateShortRef(): string {
  return randomBytes(4).toString('hex');
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
    /** Optional override for the CEO notification body. When absent, the default
     *  score-based message is used. Provide this for non-score gate blocks (e.g. tier gate). */
    reason?: string;
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

    // Step 2 + 3: Generate short_ref, description, and insert row.
    // generateShortRef() produces a random 8-char hex ref (~4B possibilities) —
    // globally unique across tasks, no per-task counting needed. Retry on
    // unique_violation (23505) with a freshly generated ref; collisions are
    // astronomically rare but the retry keeps the code correct under any scenario.
    const MAX_INSERT_RETRIES = 3;
    let rowId!: number;
    let shortRef!: string;
    // Sanitize description before storing and sending — the input fields come from
    // LLM-generated skill arguments and may contain dangerous tags.
    const description = sanitizeOutput(buildDescription(skillName, input));
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h from now

    for (let attempt = 1; attempt <= MAX_INSERT_RETRIES; attempt++) {
      shortRef = generateShortRef();

      try {
        rowId = await this.actionLogRepo.insert({
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
        break; // Insert succeeded
      } catch (err) {
        const isUniqueViolation = (err as { code?: string }).code === '23505';
        if (isUniqueViolation && attempt < MAX_INSERT_RETRIES) {
          this.logger.warn(
            { shortRef, attempt },
            'approval-trigger: short_ref collision — retrying with new random ref',
          );
          continue;
        }
        if (isUniqueViolation) {
          // All retries exhausted on unique violations — extremely unlikely with 4B
          // possibilities; if it happens, something is badly wrong (entropy failure,
          // constraint mismatch). Log at error so alerting fires.
          this.logger.error(
            { shortRef, attempt, maxRetries: MAX_INSERT_RETRIES },
            'approval-trigger: short_ref collision exhausted all retries — possible entropy issue',
          );
          throw new Error(
            `approval-trigger: failed to insert after ${MAX_INSERT_RETRIES} attempts due to short_ref collisions`,
            { cause: err },
          );
        }
        throw err; // Non-unique DB error — propagate as-is
      }
    }

    this.logger.info(
      { rowId, taskId, skillName, shortRef, currentScore, requiredScore },
      'approval-trigger: pending_approval row created',
    );

    // Step 4: Notify CEO (best-effort).
    // sendNotification() catches publish errors internally and returns false rather than
    // throwing, so we check the return value to know whether to stamp notification_sent_at.
    let notificationSent = false;
    if (this.ceoEmail && this.outboundGateway) {
      const defaultBody =
        `Curia wanted to ${description.charAt(0).toLowerCase() + description.slice(1)}, ` +
        `but the autonomy score (${currentScore}) is below the required threshold (${requiredScore}).`;
      const notificationBody =
        `${opts.reason ?? defaultBody}\n\n` +
        `Reference: ${shortRef}\n` +
        `Expires: ${expiresAt.toISOString()}\n\n` +
        `Reply to approve, deny, or dismiss this request.`;
      const sent = await this.outboundGateway.sendNotification({
        notificationType: 'approval_requested',
        ceoEmail: this.ceoEmail,
        subject: `Approval needed — ${description}`,
        body: notificationBody,
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
