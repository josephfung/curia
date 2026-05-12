// handler.ts — decay-warnings-list skill
//
// Returns KG nodes flagged by DreamEngine for CEO re-confirmation before archival.
// A node is warned if it's important (high sensitivity or high connectivity) and
// its confidence has dropped to the archive threshold. The CEO has 7 days to confirm
// or dismiss before the node is auto-archived.
//
// daysRemaining is computed from warned_at + 7 days - now(). The coordinator uses
// this to communicate urgency: "this will be archived in 3 days — is it still accurate?"

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';

// Hold-back window default — must match DreamEngine's warnHoldBackDays config default.
// Pass holdBackDays input to override if the DreamEngine config changes.
const WARN_HOLD_BACK_DAYS_DEFAULT = 7;

export class DecayWarningsListHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.entityMemory) {
      return { success: false, error: 'Entity memory service not available. Declare "entityMemory" in capabilities.' };
    }

    const holdBackDays = (ctx.input as { holdBackDays?: number }).holdBackDays ?? WARN_HOLD_BACK_DAYS_DEFAULT;
    const tz = ctx.timezone;
    const now = Date.now();

    try {
      const warnings = await ctx.entityMemory.listDecayWarnings();

      const summaries = warnings.map(w => {
        const warnedAtMs = w.warnedAt.getTime();
        const expiresAtMs = warnedAtMs + holdBackDays * 24 * 60 * 60 * 1000;
        const daysRemaining = Math.max(0, Math.ceil((expiresAtMs - now) / (24 * 60 * 60 * 1000)));
        return {
          nodeId: w.nodeId,
          nodeType: w.nodeType,
          label: w.label,
          confidence: Math.round(w.confidence * 1000) / 1000,
          sensitivity: w.sensitivity,
          edgeCount: w.edgeCount,
          reason: w.reason,
          warnedAt: tz ? toLocalIso(Math.floor(warnedAtMs / 1000), tz) : w.warnedAt.toISOString(),
          daysRemaining,
        };
      });

      ctx.log.info({ count: warnings.length }, 'decay-warnings-list: listed warnings');
      return {
        success: true,
        data: {
          warnings: summaries,
          count: summaries.length,
          displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : null,
        },
      };
    } catch (err) {
      ctx.log.error({ err }, 'decay-warnings-list: failed to list warnings');
      return { success: false, error: 'Failed to retrieve decay warnings due to a database error. Please try again.' };
    }
  }
}
