// handler.ts — executive-profile-get skill.
//
// Returns the executive's current writing voice profile as structured data
// plus a human-readable summary. Read-only, no special sensitivity.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class ExecutiveProfileGetHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.executiveProfileService) {
      return { success: false, error: 'executive-profile-get requires executiveProfileService in context. Is the executive profile configured?' };
    }

    try {
      const profile = ctx.executiveProfileService.get();
      const voice = profile.writingVoice;

      // Build a readable summary for display in conversation.
      const lines: string[] = [];

      if (voice.tone.length > 0) {
        lines.push(`Tone: ${voice.tone.join(', ')}`);
      }
      lines.push(`Formality: ${voice.formality}/100`);

      if (voice.patterns.length > 0) {
        lines.push('', 'Writing patterns:');
        for (const p of voice.patterns) {
          lines.push(`  - ${p}`);
        }
      }

      if (voice.vocabulary.prefer.length > 0) {
        lines.push(``, `Preferred words: ${voice.vocabulary.prefer.join(', ')}`);
      }
      if (voice.vocabulary.avoid.length > 0) {
        lines.push(`Words to avoid: ${voice.vocabulary.avoid.join(', ')}`);
      }

      if (voice.signOff) {
        lines.push(``, `Sign-off: ${voice.signOff}`);
      }

      return {
        success: true,
        data: {
          profile,
          summary: lines.join('\n'),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'executive-profile-get failed');
      return { success: false, error: message };
    }
  }
}
