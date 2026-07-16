// voice-learn — weekly WritingVoice refinement from (draft, sent) diffs (#1423).
//
// Replaces the old heuristic scoring/threshold/provenance machinery with a single
// batched LLM pass: read the accumulated diffs, ask the model for an updated
// free-form guide, and queue it as a "Guide Proposal" for the CEO to approve via
// the digest. This handler never writes the profile directly — human-in-the-loop.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { buildVoiceGuidePrompt, parsePendingDiffs } from '../_shared/voice-learn-logic.js';
import { PENDING_DIFFS_PATH } from '../ceo-inbox-sent-observe/handler.js';
import { VOICE_LEARNING_SCRATCH_PREFIX } from '../_shared/voice-learning-capture.js';

// Kept for Task 9 (resolve-learning-digest) and cooldown bookkeeping, even though
// this handler no longer reads/writes provenance directly.
export const DISMISSED_KEY = 'voice_learn.dismissed';
export const PENDING_PROPOSALS_PATH = `${VOICE_LEARNING_SCRATCH_PREFIX}/pending-proposals.md`;
export const PENDING_PROPOSALS_TYPE = 'voice-pending-proposals';
export const CONFIG_NAMESPACE = 'ceo_inbox';

/** Most-recent diff pairs fed into a single LLM guide-refinement call. Bounded to keep the
 *  prompt (and cost) predictable regardless of how large the never-consumed diff doc grows. */
const MAX_PAIRS = 40;

export class VoiceLearnHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    // Skill contract: never throw — normalize any profile/document/LLM failure.
    try {
      return await this.runLearn(ctx);
    } catch (err) {
      ctx.log.error({ err }, 'voice-learn: unexpected failure');
      return {
        success: false,
        error: `voice-learn failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async runLearn(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.executiveProfileService || !ctx.workingDocs || !ctx.infraLlm) {
      return {
        success: false,
        error: 'voice-learn requires executiveProfileService, workingDocs, infraLlm',
      };
    }

    const diffsDoc = await ctx.workingDocs.read(PENDING_DIFFS_PATH);
    const pairs = parsePendingDiffs(diffsDoc?.body ?? '');
    if (pairs.length === 0) {
      ctx.log.info({}, 'voice-learn: no qualifying pairs — nothing to learn');
      return { success: true, data: { pairs_considered: 0, proposed: false } };
    }

    // Dedup: skip if a guide proposal is already pending. The diff doc is never
    // consumed, so without this a still-open proposal would get re-proposed weekly.
    const existing = await ctx.workingDocs.read(PENDING_PROPOSALS_PATH);
    if (existing && /## Guide Proposal[\s\S]*?- status:\s*pending/.test(existing.body)) {
      return {
        success: true,
        data: { pairs_considered: pairs.length, proposed: false, reason: 'proposal-pending' },
      };
    }

    const currentGuide = ctx.executiveProfileService.get().writingVoice.guide ?? '';
    const batch = pairs.slice(-MAX_PAIRS);
    const res = await ctx.infraLlm.extract(buildVoiceGuidePrompt(currentGuide, batch), {
      maxTokens: 1200,
    });
    if (!res.ok) {
      ctx.log.warn({ error: res.error }, 'voice-learn: LLM failed — no proposal this run');
      return {
        success: true,
        data: { pairs_considered: pairs.length, proposed: false, reason: 'llm-failed' },
      };
    }

    const guide = res.text.trim();
    if (!guide) {
      return {
        success: true,
        data: { pairs_considered: pairs.length, proposed: false, reason: 'empty-guide' },
      };
    }

    const block = `## Guide Proposal\n- status: pending\n- generated_at: ${new Date().toISOString()}\n\n${guide}\n\n---\n`;
    if (!existing) {
      await ctx.workingDocs.create({
        path: PENDING_PROPOSALS_PATH,
        type: PENDING_PROPOSALS_TYPE,
        frontmatter: { title: 'Pending voice guide proposal' },
        body: `# Pending voice guide proposal\n\n${block}`,
        agentId: ctx.agentId,
      });
    } else {
      await ctx.workingDocs.append(PENDING_PROPOSALS_PATH, {
        content: block,
        expectedVersion: existing.version,
      });
    }

    ctx.log.info({ pairs: pairs.length }, 'voice-learn: proposed an updated guide');
    return { success: true, data: { pairs_considered: pairs.length, proposed: true } };
  }
}
