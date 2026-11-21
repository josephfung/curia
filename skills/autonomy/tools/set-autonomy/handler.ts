// handler.ts — set-autonomy skill.
//
// Updates the global autonomy score. Elevated sensitivity — requires principal CallerContext.
// Validated and rejected by the execution layer if the caller is not principal.
// Upserts autonomy_config and appends to autonomy_history.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { findOpenOnboardingTask } from '../../../../src/onboarding/state.js';
import { ONBOARDING_BANDS } from '../../../../src/onboarding/constants.js';

export class SetAutonomyHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.autonomyService) {
      return { success: false, error: 'set-autonomy requires autonomyService in context. Declare "autonomyService" in capabilities.' };
    }

    const { score, reason } = ctx.input as { score?: unknown; reason?: unknown };

    // Validate score input — the LLM may pass a numeric string; reject other types
    // explicitly (null, boolean, arrays all coerce to 0 via Number(), which would silently
    // reset the score to Restricted without any validation error).
    const parsedScore = typeof score === 'number'
      ? score
      : (typeof score === 'string' && score.trim() !== '' ? Number(score) : NaN);
    if (!Number.isFinite(parsedScore)) {
      return { success: false, error: `Invalid score: "${score}". Must be a number between 0 and 100.` };
    }

    // Round to nearest integer — tolerate minor float imprecision from the LLM
    const intScore = Math.round(parsedScore);

    // While the onboarding program is open the principal chooses among its three bands.
    // If the lookup itself throws we log a warn and apply no band limit: the principal
    // explicitly asked for this score and authorization already gates the tool, so blocking
    // autonomy changes on a lookup failure would be worse than letting one through.
    if (ctx.taskRepo) {
      let onboardingOpen = false;
      try {
        onboardingOpen = (await findOpenOnboardingTask(ctx.taskRepo)) !== null;
      } catch (err) {
        ctx.log.warn({ err }, 'set-autonomy: onboarding task lookup failed; applying no band limit');
      }
      if (onboardingOpen && !(ONBOARDING_BANDS as readonly number[]).includes(intScore)) {
        return {
          success: false,
          error: 'During onboarding the independence level is 65 (Draft only), 75 (Ask first) or 85 (Spot-check).',
        };
      }
    } else {
      ctx.log.warn('set-autonomy: no taskRepo capability, so the onboarding band limit cannot be checked; applying none');
    }

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
