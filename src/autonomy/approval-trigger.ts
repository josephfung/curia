// approval-trigger.ts — ApprovalTriggerService.
//
// Owns the approval request flow when an autonomy gate blocks a skill: dedup check, row
// insertion, short_ref generation and description building. See ADR-018 and issue #427.
//
// It notifies no one (#2159). It used to email the principal and DM every chat identity
// for each request. Now it records one principal.report item (the request's single digest
// mention) and registers what the principal should be shown; the agent that owns the turn
// delivers the approval on one channel with deliver-approval. Approvals no agent delivers
// within 15 minutes are emailed by the expiry sweep's safety net.

import { randomBytes } from 'node:crypto';
import type { ActionLogRepo } from './action-log-repo.js';
import type { ApprovalDelivery } from './approval-delivery.js';
import type { EventBus } from '../bus/bus.js';
import { createPrincipalReport } from '../bus/events.js';
import type { Logger } from '../logger.js';
import { sanitizeOutput } from '../skills/sanitize.js';
import type { SendRecipientPin } from '../skills/_shared/recipient-reference.js';
// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ApprovalRequestResult =
  | { created: true; shortRef: string }
  | { created: false; reason: 'duplicate'; existingShortRef: string };

/**
 * What the blocked agent is told about a new approval. One place, so every gate gives the
 * same instruction: deliver it yourself, on one channel (#2159).
 */
export function approvalAdvisory(shortRef: string): string {
  return (
    `An approval request was created (ref: ${shortRef}). Deliver it to the principal now with ` +
    `deliver-approval, on the channel their standing preferences name for urgent items.`
  );
}

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
  { test: (n) => n === 'calendar-respond-to-invite', verb: 'Respond to calendar invite' },
  { test: (n) => n === 'email-reply', verb: 'Send email reply' },
  { test: (n) => n === 'email-draft-save', verb: 'Save email draft' },
  { test: (n) => n === 'dispatcher-relay', verb: 'Relay withheld reply' },
  { test: (n) => n === 'store-fact', verb: 'Store fact' },
  { test: (n) => n.startsWith('signal-'), verb: 'Send Signal message' },
  { test: (n) => n.startsWith('sms-'), verb: 'Send SMS' },
  { test: (n) => n.startsWith('scheduler-'), verb: 'Schedule job' },
];

/**
 * Build a human-readable one-liner from skill name and input fields.
 * Used in principal notifications, the pending-actions digest, and the
 * coordinator's advisory failure message.
 */
export function buildDescription(
  toolName: string,
  input: Record<string, unknown>,
): string {
  // Determine verb
  let verb = '';
  for (const rule of VERB_RULES) {
    if (rule.test(toolName)) { verb = rule.verb; break; }
  }
  if (!verb) return `Run ${toolName}`;

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
  // (Fallback to "Run {toolName}" is only for truly unknown skills above.)
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
    private readonly logger: Logger,
    /** Publishes the request's digest mention. Absent in tests that only exercise rows. */
    private readonly bus?: Pick<EventBus, 'publish'>,
    /** Receives the principal-facing display for delivery. Absent without an outbound stack. */
    private readonly approvalDelivery?: Pick<ApprovalDelivery, 'registerDisplay'>,
  ) {}

  /**
   * Trigger an approval request when an autonomy gate blocks a skill.
   *
   * Steps:
   *   1. Dedup — check for existing pending_approval row with same skill + payload in same task
   *   2. Generate short_ref and description
   *   3. Insert autonomy_action_log row
   *   4. Register the display for deliver-approval, and queue the digest mention
   *
   * Returns the result so the execution layer can enrich the advisory error message.
   */
  async request(opts: {
    taskId: string;
    conversationId?: string;
    toolName: string;
    actionRisk: string;
    input: Record<string, unknown>;
    currentScore: number;
    requiredScore: number;
    /** Optional override for the principal notification body. When absent, the default
     *  score-based message is used. Provide this for non-score gate blocks (e.g. tier gate). */
    reason?: string;
    /**
     * When set, treat a pending_approval on this task whose skill is in the list
     * as a duplicate (#1733) — used by the dispatcher relay so it joins a
     * reply-class approval already pending on the same turn, not an unrelated
     * calendar (etc.) approval.
     */
    dedupePendingSkillsOnTask?: readonly string[];
    /**
     * What the principal is shown: the description and the notification details.
     * Defaults to `input`. The stored payload is always `input`, so an approval
     * re-runs the skill exactly as the agent called it. Send skills pass a copy
     * whose contact references are resolved to "Name <address>" (#2033) — a bare
     * contact UUID tells the approver nothing about where the message goes.
     */
    displayInput?: Record<string, unknown>;
    /**
     * Hinted recipients pinned beside the skill payload. Replay refuses the
     * send when the identity or its name no longer matches (#2047).
     */
    sendResolution?: readonly SendRecipientPin[];
  }): Promise<ApprovalRequestResult> {
    const { taskId, conversationId, toolName, actionRisk, input, currentScore, requiredScore } = opts;
    const shown = opts.displayInput ?? input;

    // Step 1: Dedup check
    if (opts.dedupePendingSkillsOnTask && opts.dedupePendingSkillsOnTask.length > 0) {
      const replyPending = await this.actionLogRepo.findPendingByTaskAndSkills(
        taskId,
        opts.dedupePendingSkillsOnTask,
      );
      if (replyPending) {
        const existingShortRef = replyPending.shortRef ?? 'unknown';
        this.logger.info(
          {
            taskId,
            toolName,
            existingShortRef,
            existingSkill: replyPending.toolName,
            skillScope: opts.dedupePendingSkillsOnTask,
          },
          'approval-trigger: duplicate request — reply-class pending_approval already exists on this task',
        );
        return { created: false, reason: 'duplicate', existingShortRef };
      }
    }
    const existing = await this.actionLogRepo.findPendingByTaskAndSkill(taskId, toolName, input);
    if (existing) {
      const existingShortRef = existing.shortRef ?? 'unknown';
      if (!existing.shortRef) {
        // A pending_approval row without a short_ref should not happen — flag it.
        this.logger.warn(
          { taskId, toolName },
          'approval-trigger: existing pending_approval row has null short_ref — data inconsistency',
        );
      }
      this.logger.info(
        { taskId, toolName, existingShortRef },
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
    const description = sanitizeOutput(buildDescription(toolName, shown));
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h from now

    for (let attempt = 1; attempt <= MAX_INSERT_RETRIES; attempt++) {
      shortRef = generateShortRef();

      try {
        rowId = await this.actionLogRepo.insert({
          taskId,
          conversationId,
          toolName,
          actionRisk,
          outcome: 'pending_approval',
          payload: input,
          expiresAt,
          shortRef,
          description,
          sendResolution: opts.sendResolution ? [...opts.sendResolution] : undefined,
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
      { rowId, taskId, toolName, shortRef, currentScore, requiredScore },
      'approval-trigger: pending_approval row created',
    );

    // Step 4: what the principal will be shown when the agent delivers it. displayInput has
    // contact references resolved to names (#2033); the stored payload keeps the references.
    const preamble = opts.reason ??
      `Curia wanted to ${description.charAt(0).toLowerCase() + description.slice(1)}, ` +
      `but the autonomy score (${currentScore}) is below the required threshold (${requiredScore}).`;
    this.approvalDelivery?.registerDisplay(shortRef, { preamble, payload: shown });

    // The request's one digest mention (#2159). Best-effort: the row exists either way, and
    // the agent has been told to deliver it.
    if (this.bus) {
      try {
        await this.bus.publish('dispatch', createPrincipalReport({
          summary: `Waiting for your approval: ${description}`,
          urgency: 'digest',
          source: 'approval_pending',
          ...(conversationId ? { conversationId } : {}),
          actionShortRef: shortRef,
          parentEventId: taskId,
          sourceLayer: 'dispatch',
        }));
      } catch (err) {
        this.logger.error({ err, rowId, shortRef }, 'approval-trigger: failed to queue the digest mention — the approval still exists');
      }
    }

    return { created: true, shortRef };
  }
}
