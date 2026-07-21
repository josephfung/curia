// handler.ts — list-pending-actions skill implementation.
//
// Returns all non-expired pending approval requests so the CEO can see what's
// waiting for their decision. Read-only — no state changes.
//
// SECURITY: this is a sensitive *read* of the approval queue. #1126 reclassified it from
// `elevated` to `normal` + action_risk:'none' + allowed_callers:['coordinator']. The right
// control here is WHO MAY CALL it, not who originated the task: the 8am digest is a scheduled
// task that runs *as the coordinator*, and the CEO's "what's pending?" turn also runs through the
// coordinator. The execution-layer allowed_callers gate enforces this; there is no handler-level
// origination re-check (the old principal-or-system check was exactly the over-broad `system`
// allowance — commit 3bd3d224 — that the live-principal redefinition removes). This move is what
// keeps the digest working without giving any system-lineage context standing at the elevated gate.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { toLocalIso, formatDisplayTimezone } from '../../../../src/time/timestamp.js';

export class ListPendingActionsHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.actionLogRepo) {
      return { success: false, error: 'list-pending-actions requires actionLogRepo capability' };
    }

    try {
      const rows = await ctx.actionLogRepo.findAllPending();

      const tz = ctx.timezone;
      const pending = rows.map((row) => ({
        short_ref: row.shortRef,
        description: row.description,
        skill_name: row.toolName,
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
