import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import { ConfigStore } from '../../src/memory/config-store.js';
import { readVoiceProposal, readCompletionDigest, digestMapToItems } from '../_shared/learning-state.js';
import { renderCompletionSection, renderVoiceGuideSection } from '../_shared/learning-digest.js';

export class ListLearningDigestHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    // Skill contract: never throw — a failed document read becomes a failure result.
    try {
      // Both the voice proposal and the completion digest now live in config (#1438).
      // Guarded on ctx.entityMemory since it's not a hard capability requirement of this
      // skill — without it, neither section renders (same net effect as both being absent).
      const store = ctx.entityMemory ? new ConfigStore(ctx.entityMemory, ctx.log) : null;
      const guide = store ? await readVoiceProposal(store, ctx.log) : null;
      const completion_items = store ? digestMapToItems(await readCompletionDigest(store, ctx.log)) : [];
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
