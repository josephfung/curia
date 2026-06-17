// handler.ts — list-pending-actions skill implementation.
//
// Returns all non-expired pending approval requests so the CEO can see what's
// waiting for their decision. Read-only — no state changes.
//
// SECURITY: sensitivity: "elevated" ensures this is gate-checked at the execution layer.
// This handler-level check is defense-in-depth: principal (active CEO conversation) and
// system (YAML-declared scheduled jobs via makeSystemOriginator()) are both accepted.
// Agent-originated tasks are blocked here and at the gate — they must not read the queue.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';
import { isPrincipalOriginated, isSystemOriginated } from '../../src/contacts/principal.js';

export class ListPendingActionsHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    // Defense-in-depth: principal (CEO conversation) or system (YAML job) only.
    // Agent-originated tasks are explicitly excluded — autonomously invented jobs
    // must not have standing read access to the approval queue.
    if (!isPrincipalOriginated(ctx.taskMetadata) && !isSystemOriginated(ctx.taskMetadata)) {
      ctx.log.warn('list-pending-actions: rejected — task not originated by principal or system');
      return { success: false, error: 'This skill requires principal or system authorization.' };
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
        created_at: toLocalIso(Math.floor(row.createdAt.getTime() / 1000), tz),
        expires_at: row.expiresAt ? toLocalIso(Math.floor(row.expiresAt.getTime() / 1000), tz) : null,
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
