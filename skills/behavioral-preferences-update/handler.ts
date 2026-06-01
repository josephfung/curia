// handler.ts — behavioral-preferences-update skill
//
// Writes to OfficeIdentity.behavioralPreferences via OfficeIdentityService.
// 'append' deduplicates by exact string match (idempotent; skips DB write if nothing changed).
// 'replace' overwrites the full list unconditionally.
// Mirrors the executive-profile-update skill pattern.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { OfficeIdentity } from '../../src/identity/types.js';

export class BehavioralPreferencesUpdateHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.officeIdentityService) {
      // Missing capability = deployment misconfiguration. Log at error so it surfaces in traces.
      ctx.log.error(
        'behavioral-preferences-update: officeIdentityService not in context — ' +
        'check that officeIdentityService is passed to ExecutionLayer constructor',
      );
      return {
        success: false,
        error: 'behavioral-preferences-update requires officeIdentityService in context.',
      };
    }

    const { operation, entries } = ctx.input as { operation?: unknown; entries?: unknown };

    if (operation !== 'append' && operation !== 'replace') {
      return { success: false, error: 'operation must be "append" or "replace".' };
    }
    if (
      !Array.isArray(entries) ||
      entries.length === 0 ||
      !entries.every((e) => typeof e === 'string')
    ) {
      return { success: false, error: 'entries must be a non-empty array of strings.' };
    }

    try {
      const current = ctx.officeIdentityService.get();
      const existing = current.behavioralPreferences;

      let merged: string[];
      let changes: string;

      if (operation === 'append') {
        const newEntries = [...new Set((entries as string[]).filter((e) => !existing.includes(e)))];
        if (newEntries.length === 0) {
          // Nothing to write — return current state without a DB round-trip.
          return {
            success: true,
            data: {
              preferences: existing,
              summary: 'Behavioral preferences unchanged.',
              changes: 'no new entries (all already present)',
            },
          };
        }
        merged = [...existing, ...newEntries];
        changes =
          `appended ${newEntries.length} entr${newEntries.length === 1 ? 'y' : 'ies'}: ` +
          newEntries.map((e) => `"${e}"`).join(', ');
      } else {
        merged = entries as string[];
        changes = `replaced all preferences (${existing.length} → ${merged.length} entries)`;
      }

      const actor = ctx.caller?.contactId ?? ctx.caller?.role ?? 'unknown';
      const updated: OfficeIdentity = { ...current, behavioralPreferences: merged };
      await ctx.officeIdentityService.update(
        updated,
        'skill',
        `behavioral-preferences-update: ${changes} (by ${actor})`,
      );

      return {
        success: true,
        data: {
          preferences: merged,
          summary: 'Behavioral preferences updated.',
          changes,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'behavioral-preferences-update failed');
      return { success: false, error: message };
    }
  }
}
