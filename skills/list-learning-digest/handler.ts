import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { PENDING_PROPOSALS_PATH } from '../voice-learn/handler.js';
import { COMPLETION_DIGEST_PATH } from '../task-completion-from-sent/handler.js';
import {
  parseCompletionDigest,
  parseVoiceGuideProposal,
  renderCompletionSection,
  renderVoiceGuideSection,
} from '../_shared/learning-digest.js';

export class ListLearningDigestHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.workingDocs) {
      return { success: false, error: 'list-learning-digest requires workingDocs' };
    }

    // Skill contract: never throw — a failed document read becomes a failure result.
    try {
      const proposalsDoc = await ctx.workingDocs.read(PENDING_PROPOSALS_PATH);
      const completionsDoc = await ctx.workingDocs.read(COMPLETION_DIGEST_PATH);

      const guide = parseVoiceGuideProposal(proposalsDoc?.body ?? '');
      const completion_items = parseCompletionDigest(completionsDoc?.body ?? '');

      const sections = [
        renderVoiceGuideSection(guide?.guide ?? null),
        renderCompletionSection(completion_items),
      ]
        .filter(Boolean)
        .join('\n');

      return {
        success: true,
        data: {
          voice_guide: guide?.guide ?? null,
          completion_items,
          sections_markdown: sections,
          message:
            !guide && completion_items.length === 0
              ? 'No pending learning-digest items.'
              : undefined,
        },
      };
    } catch (err) {
      ctx.log.error({ err }, 'list-learning-digest: unexpected failure');
      return {
        success: false,
        error: `list-learning-digest failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
