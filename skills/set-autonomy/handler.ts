// handler.ts — set-autonomy skill.
//
// Updates the global autonomy score. Elevated sensitivity — requires CEO CallerContext.
// Validated and rejected by the execution layer if the caller is not CEO.
// Upserts autonomy_config and appends to autonomy_history.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class SetAutonomyHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.autonomyService) {
      return { success: false, error: 'set-autonomy requires autonomyService in context. Is infrastructure: true set in the manifest?' };
    }

    const { score, reason } = ctx.input as { score?: unknown; reason?: unknown };

    // Validate score input — the LLM may pass a float or string
    const parsedScore = typeof score === 'number' ? score : Number(score);
    if (!Number.isFinite(parsedScore)) {
      return { success: false, error: `Invalid score: "${score}". Must be a number between 0 and 100.` };
    }

    // Round to nearest integer — tolerate minor float imprecision from the LLM
    const intScore = Math.round(parsedScore);

    // Prefer contactId over role for the audit identifier — contactId is a unique, stable
    // identifier while role is a broad category (multiple callers can share a role).
    const changedBy = ctx.caller?.contactId ?? ctx.caller?.role ?? 'system';
    const reasonStr = typeof reason === 'string' && reason.trim()
      ? reason.trim().slice(0, 500)  // Cap at 500 chars to prevent context-stuffing
      : undefined;

    try {
      // setScore returns previousScore atomically (captured inside the CTE), so we don't
      // need a separate getConfig() call that could race with a concurrent write.
      const updated = await ctx.autonomyService.setScore(intScore, changedBy, reasonStr);
      const { previousScore } = updated;

      const bandLabels: Record<string, string> = {
        'full': 'Full',
        'spot-check': 'Spot-check',
        'approval-required': 'Approval Required',
        'draft-only': 'Draft Only',
        'restricted': 'Restricted',
      };
      const bandLabel = bandLabels[updated.band] ?? updated.band;

      const changeDesc = previousScore !== null
        ? `${previousScore} → ${updated.score}`
        : `${updated.score}`;

      return {
        success: true,
        data: {
          score: updated.score,
          band: updated.band,
          previous_score: previousScore,
          summary: `Autonomy score updated: ${changeDesc} (${bandLabel}).${reasonStr ? ` Reason: "${reasonStr}".` : ''}`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'set-autonomy failed');
      return { success: false, error: message };
    }
  }
}
