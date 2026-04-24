// handler.ts — get-autonomy skill.
//
// Reports the current global autonomy score and band to the CEO.
// Includes the last 3 history entries so the CEO can see recent changes.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class GetAutonomyHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.autonomyService) {
      return { success: false, error: 'get-autonomy requires autonomyService in context. Declare "autonomyService" in capabilities.' };
    }

    try {
      const config = await ctx.autonomyService.getConfig();

      if (!config) {
        return { success: false, error: 'Autonomy config not found — migration 011 may not have run.' };
      }

      // History is supplementary — a failure here should not block showing the current score.
      let history: import('../../src/autonomy/autonomy-service.js').AutonomyHistoryEntry[] = [];
      try {
        history = await ctx.autonomyService.getHistory(3);
      } catch (err) {
        ctx.log.warn({ err }, 'get-autonomy: could not load history — showing current score only');
      }

      // Format the band label for human display
      const bandLabels: Record<string, string> = {
        'full': 'Full',
        'spot-check': 'Spot-check',
        'approval-required': 'Approval Required',
        'draft-only': 'Draft Only',
        'restricted': 'Restricted',
      };
      const bandLabel = bandLabels[config.band] ?? config.band;

      // Build a readable summary
      const lines: string[] = [
        `Autonomy score: ${config.score} — ${bandLabel}`,
        `Last updated: ${config.updatedAt.toISOString().split('T')[0]} by ${config.updatedBy}`,
      ];

      if (history.length > 0) {
        lines.push('', 'Recent changes:');
        for (const entry of history) {
          const date = entry.changedAt.toISOString().split('T')[0] ?? '';
          const prev = entry.previousScore !== null ? `${entry.previousScore} → ` : '';
          const reason = entry.reason ? `  "${entry.reason}"` : '';
          lines.push(`  ${date}  ${prev}${entry.score} (${entry.band})${reason}  — ${entry.changedBy}`);
        }
      }

      return {
        success: true,
        data: {
          score: config.score,
          band: config.band,
          summary: lines.join('\n'),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'get-autonomy failed');
      return { success: false, error: message };
    }
  }
}
