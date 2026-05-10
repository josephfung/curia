// handler.ts — dismiss-action skill implementation.
//
// Dismisses a pending approval request: transitions to outcome = 'resolved_externally'.
// Used when the CEO handled the action outside Curia.
//
// SECURITY: sensitivity: "elevated" + ceoInitiated check.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { createHumanDecision } from '../../src/bus/events.js';
import { isPrincipalOriginated } from '../../src/contacts/principal.js';

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
      // Skip if taskEventId is absent — an empty parentEventId breaks event lineage.
      if (ctx.taskEventId) {
        const senderId = typeof ctx.taskMetadata?.senderId === 'string' ? ctx.taskMetadata.senderId : 'unknown';
        const channelId = typeof ctx.taskMetadata?.channelId === 'string' ? ctx.taskMetadata.channelId : 'unknown';
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
      } else {
        ctx.log.warn({ rowId: row.id }, 'dismiss-action: no taskEventId — skipping human.decision audit event');
      }

      ctx.log.info({ rowId: row.id, shortRef: row.shortRef }, 'dismiss-action: request dismissed');
      return { success: true, data: `Dismissed: ${row.description ?? row.skillName} (${row.shortRef})` };
    } catch (err) {
      ctx.log.error({ err }, 'dismiss-action: unexpected failure');
      return { success: false, error: 'dismiss-action failed unexpectedly' };
    }
  }
}
