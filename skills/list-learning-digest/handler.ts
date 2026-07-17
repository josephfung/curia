import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { ConfigStore } from '../../src/memory/config-store.js';
import { readVoiceProposal } from '../_shared/learning-state.js';
import { COMPLETION_DIGEST_PATH } from '../task-completion-from-sent/handler.js';
import {
  parseCompletionDigest,
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
      // The voice proposal now lives in config (Task 1/2 of #1438); the completion digest
      // stays a markdown doc for now (migrated in Task 4). Guarded on ctx.entityMemory since
      // it's not a hard capability requirement of this skill — without it, no voice guide
      // section renders (same net effect as an absent proposal).
      const guide = ctx.entityMemory
        ? await readVoiceProposal(new ConfigStore(ctx.entityMemory, ctx.log))
        : null;
      const completionsDoc = await ctx.workingDocs.read(COMPLETION_DIGEST_PATH);

      const completion_items = parseCompletionDigest(completionsDoc?.body ?? '');
      const guideText = guide?.status === 'pending' ? guide.guide : null;

      const sections = [
        renderVoiceGuideSection(guideText),
        renderCompletionSection(completion_items),
      ]
        .filter(Boolean)
        .join('\n');

      return {
        success: true,
        data: {
          voice_guide: guideText,
          completion_items,
          sections_markdown: sections,
          message:
            !guideText && completion_items.length === 0
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
