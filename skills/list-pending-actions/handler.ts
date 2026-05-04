// handler.ts — list-pending-actions skill implementation.
//
// Returns all non-expired pending approval requests so the CEO can see what's
// waiting for their decision. Read-only — no state changes.
//
// SECURITY: sensitivity: "elevated" ensures only the CEO can call this.
// The ceoInitiated check is a defense-in-depth secondary gate.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class ListPendingActionsHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    // CEO-origin check — defense-in-depth (elevated gate is primary)
    if (ctx.taskMetadata?.ceoInitiated !== true) {
      ctx.log.warn('list-pending-actions: rejected — ceoInitiated flag absent or false');
      return { success: false, error: 'This skill requires direct CEO authorization.' };
    }

    if (!ctx.actionLogRepo) {
      return { success: false, error: 'list-pending-actions requires actionLogRepo capability' };
    }

    const rows = await ctx.actionLogRepo.findAllPending();

    const pending = rows.map((row) => ({
      short_ref: row.shortRef,
      description: row.description,
      skill_name: row.skillName,
      created_at: row.createdAt.toISOString(),
      expires_at: row.expiresAt?.toISOString() ?? null,
    }));

    if (pending.length === 0) {
      return { success: true, data: { pending: [], message: 'No pending approval requests.' } };
    }

    return { success: true, data: { pending } };
  }
}
