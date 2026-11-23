// handler.ts — office-tone-update skill
//
// Writes OfficeIdentity.tone via OfficeIdentityService. Only the tone changes; the rest of
// the identity is carried over from the current version. Used by the onboarding program's
// tone step (#2360). Mirrors behavioral-preferences-update.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import type { OfficeIdentity } from '../../../../src/identity/types.js';
import { TONE_STYLE_MAX_LENGTH } from '../../../../src/identity/types.js';

export class OfficeToneUpdateHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.officeIdentityService) {
      ctx.log.error(
        'office-tone-update: officeIdentityService not in context — ' +
        'check that officeIdentityService is passed to ExecutionLayer constructor',
      );
      return { success: false, error: 'office-tone-update requires officeIdentityService in context.' };
    }

    const { style, verbosity } = ctx.input as { style?: unknown; verbosity?: unknown };

    if (style === undefined && verbosity === undefined) {
      return { success: false, error: 'Provide style, verbosity, or both.' };
    }
    if (style !== undefined) {
      if (typeof style !== 'string' || style.trim() === '') {
        return { success: false, error: 'style must be a non-empty string.' };
      }
      if (style.length > TONE_STYLE_MAX_LENGTH) {
        return { success: false, error: `style must be at most ${TONE_STYLE_MAX_LENGTH} characters.` };
      }
    }
    if (verbosity !== undefined) {
      if (typeof verbosity !== 'number' || !Number.isInteger(verbosity) || verbosity < 0 || verbosity > 100) {
        return { success: false, error: 'verbosity must be an integer between 0 and 100.' };
      }
    }

    try {
      const current = ctx.officeIdentityService.get();
      const tone = {
        style: typeof style === 'string' ? style : current.tone.style,
        verbosity: typeof verbosity === 'number' ? verbosity : current.tone.verbosity,
      };
      const actor = ctx.caller?.contactId ?? ctx.caller?.role ?? 'unknown';
      const updated: OfficeIdentity = { ...current, tone };
      await ctx.officeIdentityService.update(
        updated,
        'tool',
        `office-tone-update: tone updated (by ${actor})`,
      );
      return { success: true, data: { style: tone.style, verbosity: tone.verbosity } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'office-tone-update failed');
      return { success: false, error: message };
    }
  }
}
