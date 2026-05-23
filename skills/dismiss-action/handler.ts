// handler.ts — dismiss-action skill implementation.
//
// Dismisses a pending approval request: transitions to outcome = 'resolved_externally'.
// Used when the CEO handled the action outside Curia.
//
// SECURITY: sensitivity: "elevated" + isPrincipalOriginated check.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { createHumanDecision } from '../../src/bus/events.js';
import { isPrincipalOriginated } from '../../src/contacts/principal.js';
import type { TaskOriginator } from '../../src/contacts/types.js';

export class DismissActionHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!isPrincipalOriginated(ctx.taskMetadata)) {
      ctx.log.warn('dismiss-action: rejected — task not originated by principal');
      return { success: false, error: 'This skill requires principal authorization.' };
    }

    if (!ctx.actionLogRepo) {
      return { success: false, error: 'dismiss-action requires actionLogRepo capability' };
    }
    if (!ctx.bus) {
      return { success: false, error: 'dismiss-action requires bus capability' };
    }

    try {
      const shortRef = typeof ctx.input.short_ref === 'string' && ctx.input.short_ref.trim()
        ? ctx.input.short_ref.trim()
        : undefined;

      const resolved = await ctx.actionLogRepo.resolvePending(shortRef);
      if (!resolved.found) {
        return { success: false, error: resolved.error };
      }

      const { row } = resolved;

      const transitioned = await ctx.actionLogRepo.resolveRow(row.id, 'resolved_externally', 'ceo');
      if (!transitioned) {
        ctx.log.warn({ rowId: row.id, shortRef: row.shortRef }, 'dismiss-action: row was already resolved concurrently');
        return { success: false, error: `Request '${row.shortRef}' was already resolved by another action` };
      }

      // Publish human.decision audit event (best-effort).
      //
      // originator is stamped by the dispatcher on every task and carries the contactId
      // and channel of whoever initiated the task chain. Must be present if we passed the
      // principal-origin check above — if missing, that indicates a dispatch-layer bug.
      // Log loudly but don't publish a fake audit row with placeholder IDs, as a
      // counterfeit audit trail is worse than a missing one. See ADR-017.
      const originator = ctx.taskMetadata?.originator as TaskOriginator | undefined;
      const senderId = originator?.contactId;
      const channelId = originator?.channel;

      if (!senderId || !channelId || !ctx.taskEventId) {
        ctx.log.error(
          { senderId, channelId, taskEventId: ctx.taskEventId },
          'dismiss-action: audit metadata incomplete — originator/taskEventId should always be present when task is principal-originated. This indicates a dispatch-layer bug.',
        );
      } else {
        try {
          await ctx.bus.publish(
            'dispatch',
            createHumanDecision({
              decision: 'dismiss',
              deciderId: senderId,
              deciderChannel: channelId,
              subjectEventId: row.taskId,
              subjectSummary: `CEO dismissed (handled externally): ${row.description ?? row.skillName}`,
              contextShown: ['short_ref', 'description', 'skill_name'],
              presentedAt: row.createdAt,
              decidedAt: new Date(),
              defaultAction: 'block',
              parentEventId: ctx.taskEventId,
            }),
          );
        } catch (err) {
          ctx.log.error({ err, rowId: row.id }, 'dismiss-action: failed to publish human.decision event');
        }
      }

      ctx.log.info({ rowId: row.id, shortRef: row.shortRef }, 'dismiss-action: request dismissed');
      return { success: true, data: `Dismissed: ${row.description ?? row.skillName} (${row.shortRef})` };
    } catch (err) {
      ctx.log.error({ err }, 'dismiss-action: unexpected failure');
      return { success: false, error: 'dismiss-action failed unexpectedly' };
    }
  }
}
