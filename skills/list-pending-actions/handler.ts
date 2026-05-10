// handler.ts — list-pending-actions skill implementation.
//
// Returns all non-expired pending approval requests so the CEO can see what's
// waiting for their decision. Read-only — no state changes.
//
// SECURITY: sensitivity: "elevated" ensures only the CEO can call this.
// The ceoInitiated check is a defense-in-depth secondary gate.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';
import { isPrincipalOriginated } from '../../src/contacts/principal.js';

export class ListPendingActionsHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    // Principal-origin check — defense-in-depth (elevated gate is primary)
    if (!isPrincipalOriginated(ctx.taskMetadata)) {
      ctx.log.warn('list-pending-actions: rejected — task not originated by principal');
      return { success: false, error: 'This skill requires principal authorization.' };
    }

    if (!ctx.actionLogRepo) {
      return { success: false, error: 'list-pending-actions requires actionLogRepo capability' };
    }

    try {
      const rows = await ctx.actionLogRepo.findAllPending();

      const tz = ctx.timezone;
      const pending = rows.map((row) => ({
        short_ref: row.shortRef,
        description: row.description,
        skill_name: row.skillName,
        created_at: tz ? toLocalIso(Math.floor(row.createdAt.getTime() / 1000), tz) : row.createdAt.toISOString(),
        expires_at: row.expiresAt
          ? (tz ? toLocalIso(Math.floor(row.expiresAt.getTime() / 1000), tz) : row.expiresAt.toISOString())
          : null,
      }));

      if (pending.length === 0) {
        return {
          success: true,
          data: {
            pending: [],
            message: 'No pending approval requests.',
            displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : undefined,
          },
        };
      }

      return {
        success: true,
        data: {
          pending,
          displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : undefined,
        },
      };
    } catch (err) {
      ctx.log.error({ err }, 'list-pending-actions: failed to query pending approvals');
      return { success: false, error: 'Unable to list pending approval requests right now.' };
    }
  }
}
