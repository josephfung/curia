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

    // Prefer the caller's role as the audit identifier; fall back to contactId.
    // CallerContext.role is string | null, so we guard against null explicitly.
    const changedBy = ctx.caller?.role ?? ctx.caller?.contactId ?? 'ceo';
    const reasonStr = typeof reason === 'string' && reason.trim() ? reason.trim() : undefined;

    try {
      const previous = await ctx.autonomyService.getConfig();
      const previousScore = previous?.score ?? null;

      const updated = await ctx.autonomyService.setScore(intScore, changedBy, reasonStr);

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
