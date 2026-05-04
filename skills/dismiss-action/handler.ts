// handler.ts — dismiss-action skill implementation.
//
// Dismisses a pending approval request: transitions to outcome = 'resolved_externally'.
// Used when the CEO handled the action outside Curia.
//
// SECURITY: sensitivity: "elevated" + ceoInitiated check.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { createHumanDecision } from '../../src/bus/events.js';

export class DismissActionHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (ctx.taskMetadata?.ceoInitiated !== true) {
      ctx.log.warn('dismiss-action: rejected — ceoInitiated flag absent or false');
      return { success: false, error: 'This skill requires direct CEO authorization.' };
    }

    if (!ctx.actionLogRepo) {
      return { success: false, error: 'dismiss-action requires actionLogRepo capability' };
    }
    if (!ctx.bus) {
      return { success: false, error: 'dismiss-action requires bus capability' };
    }

    const shortRef = typeof ctx.input.short_ref === 'string' && ctx.input.short_ref.trim()
      ? ctx.input.short_ref.trim()
      : undefined;

    const resolved = await ctx.actionLogRepo.resolvePending(shortRef);
    if (!resolved.found) {
      return { success: false, error: resolved.error };
    }

    const { row } = resolved;

    await ctx.actionLogRepo.resolveRow(row.id, 'resolved_externally', 'ceo');

    // Publish human.decision audit event (best-effort)
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
          parentEventId: ctx.taskEventId ?? '',
        }),
      );
    } catch (err) {
      ctx.log.error({ err, rowId: row.id }, 'dismiss-action: failed to publish human.decision event');
    }

    ctx.log.info({ rowId: row.id, shortRef: row.shortRef }, 'dismiss-action: request dismissed');
    return { success: true, data: `Dismissed: ${row.description ?? row.skillName} (${row.shortRef})` };
  }
}
