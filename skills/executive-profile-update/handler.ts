// handler.ts — executive-profile-update skill.
//
// Updates the executive's writing voice profile. Elevated sensitivity —
// requires CEO CallerContext. Accepts partial updates: only the fields
// provided are merged onto the current profile. Unchanged fields keep
// their existing values.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { WritingVoice } from '../../src/executive/types.js';

// Shape of the partial input the LLM provides. All fields are optional —
// only the fields being changed need to be included.
interface PartialWritingVoiceInput {
  tone?: string[];
  formality?: number | string;
  patterns?: string[];
  vocabulary?: {
    prefer?: string[];
    avoid?: string[];
  };
  sign_off?: string;
}

export class ExecutiveProfileUpdateHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.executiveProfileService) {
      return { success: false, error: 'executive-profile-update requires executiveProfileService in context. Is the executive profile configured?' };
    }

    const { writing_voice } = ctx.input as { writing_voice?: PartialWritingVoiceInput };
    if (!writing_voice || typeof writing_voice !== 'object' || Array.isArray(writing_voice)) {
      return { success: false, error: 'Input must include a "writing_voice" object with the fields to update.' };
    }

    try {
      // Read the current profile as the base for merging.
      const current = ctx.executiveProfileService.get();
      const currentVoice = current.writingVoice;

      // Build the merged voice — only override fields that are present in the input.
      const merged: WritingVoice = {
        tone: Array.isArray(writing_voice.tone) ? writing_voice.tone : currentVoice.tone,
        formality: mergeFormality(writing_voice.formality, currentVoice.formality),
        patterns: Array.isArray(writing_voice.patterns) ? writing_voice.patterns : currentVoice.patterns,
        vocabulary: {
          prefer: Array.isArray(writing_voice.vocabulary?.prefer)
            ? writing_voice.vocabulary.prefer
            : currentVoice.vocabulary.prefer,
          avoid: Array.isArray(writing_voice.vocabulary?.avoid)
            ? writing_voice.vocabulary.avoid
            : currentVoice.vocabulary.avoid,
        },
        signOff: typeof writing_voice.sign_off === 'string' ? writing_voice.sign_off : currentVoice.signOff,
      };

      // Build a human-readable changes summary before updating.
      const changes = buildChangesSummary(currentVoice, merged);

      // Persist — validation happens inside update().
      // changedBy uses a fixed source label (not caller identity) to keep the
      // audit trail filterable. Actor identity goes in the note.
      const actor = ctx.caller?.contactId ?? ctx.caller?.role ?? 'unknown';
      await ctx.executiveProfileService.update(
        { writingVoice: merged },
        'skill',
        `${changes} (by ${actor})`,
      );

      const updated = ctx.executiveProfileService.get();

      return {
        success: true,
        data: {
          profile: updated,
          summary: `Executive writing voice updated.`,
          changes,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'executive-profile-update failed');
      return { success: false, error: message };
    }
  }
}

// Parse formality from the LLM input — the LLM may pass a numeric string.
function mergeFormality(input: number | string | undefined, fallback: number): number {
  if (input === undefined || input === null) return fallback;
  const parsed = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.round(parsed);
}

// Build a concise summary of what changed.
function buildChangesSummary(prev: WritingVoice, next: WritingVoice): string {
  const parts: string[] = [];

  if (JSON.stringify(prev.tone) !== JSON.stringify(next.tone)) {
    parts.push(`tone: [${prev.tone.join(', ')}] → [${next.tone.join(', ')}]`);
  }
  if (prev.formality !== next.formality) {
    parts.push(`formality: ${prev.formality} → ${next.formality}`);
  }
  if (JSON.stringify(prev.patterns) !== JSON.stringify(next.patterns)) {
    parts.push('patterns updated');
  }
  if (JSON.stringify(prev.vocabulary) !== JSON.stringify(next.vocabulary)) {
    parts.push('vocabulary updated');
  }
  if (prev.signOff !== next.signOff) {
    parts.push(`sign_off: "${prev.signOff}" → "${next.signOff}"`);
  }

  return parts.length > 0 ? parts.join('; ') : 'no changes';
}
