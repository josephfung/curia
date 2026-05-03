// handler.ts — get-autonomy skill.
//
// Reports the current global autonomy score and band to the CEO.
// Includes the last 3 history entries so the CEO can see recent changes.
//
// Phase 3 additions:
//   - lastSetBy: who most recently changed the score (history[0].changedBy or config.updatedBy)
//   - trend: 'improving' | 'declining' | 'stable' | null — derived from the two most recent
//     system-generated adjustments (changedBy === 'system'). Null if fewer than 2 system entries.
//   - scoredActionCount: count of autonomy_action_log rows with scored_by set (0 if table absent)

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { AutonomyHistoryEntry } from '../../src/autonomy/autonomy-service.js';

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
      let history: AutonomyHistoryEntry[] = [];
      try {
        history = await ctx.autonomyService.getHistory(3);
      } catch (err) {
        ctx.log.warn({ err }, 'get-autonomy: could not load history — showing current score only');
      }

      // --- Phase 3: lastSetBy ---
      // Use the most recent history entry's actor; fall back to config.updatedBy
      // if history is empty (e.g. first run after migration without history rows).
      const lastSetBy: string = history.length > 0 ? history[0]!.changedBy : config.updatedBy;

      // --- Phase 3: trend ---
      // Filter to system-generated adjustments only, then compare the two most recent.
      // A CEO manual override is intentional and doesn't reflect the automated trend.
      const systemEntries = history.filter(e => e.changedBy === 'system');
      let trend: 'improving' | 'declining' | 'stable' | null = null;
      if (systemEntries.length >= 2) {
        const latest = systemEntries[0]!.score;
        const previous = systemEntries[1]!.score;
        if (latest > previous) {
          trend = 'improving';
        } else if (latest < previous) {
          trend = 'declining';
        } else {
          trend = 'stable';
        }
      }

      // --- Phase 3: scoredActionCount ---
      // Swallow errors defensively in case getScoredActionCount itself throws for
      // any reason not already handled inside the method (e.g. mock misconfiguration
      // in tests, unexpected method absence on older service versions).
      let scoredActionCount = 0;
      try {
        scoredActionCount = await ctx.autonomyService.getScoredActionCount();
      } catch (err) {
        ctx.log.warn({ err }, 'get-autonomy: could not load scoredActionCount — defaulting to 0');
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
          lastSetBy,
          trend,
          scoredActionCount,
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
