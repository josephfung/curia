// voice-learn — weekly WritingVoice refinement from (draft, sent) diffs (#1423).
//
// Replaces the old heuristic scoring/threshold/provenance machinery with a single
// batched LLM pass: read the accumulated diffs, ask the model for an updated
// free-form guide, and queue it as a "Guide Proposal" for the CEO to approve via
// the digest. This handler never writes the profile directly — human-in-the-loop.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { ConfigStore } from '../../src/memory/config-store.js';
import { buildVoiceGuidePrompt, parsePendingDiffs } from '../_shared/voice-learn-logic.js';
import { parseVoiceGuideProposal } from '../_shared/learning-digest.js';
import { PENDING_DIFFS_PATH } from '../ceo-inbox-sent-observe/handler.js';
import { VOICE_LEARNING_SCRATCH_PREFIX } from '../_shared/voice-learning-capture.js';

// Kept for Task 9 (resolve-learning-digest) and cooldown bookkeeping, even though
// this handler no longer reads/writes provenance directly.
export const DISMISSED_KEY = 'voice_learn.dismissed';
export const PENDING_PROPOSALS_PATH = `${VOICE_LEARNING_SCRATCH_PREFIX}/pending-proposals.md`;
export const PENDING_PROPOSALS_TYPE = 'voice-pending-proposals';
export const CONFIG_NAMESPACE = 'ceo_inbox';

// Checkpoint (ISO timestamp string) marking the newest `sentAt` among diff pairs already fed
// to the LLM. pending-diffs.md is rolling/append-only and never consumed, so without this the
// weekly run would re-feed the SAME evidence forever — even after a proposal was approved or
// dismissed — and propose essentially the same guide again (CodeRabbit finding #11). Stored via
// ConfigStore (best-effort — see the ctx.entityMemory guard below), NOT as part of the diff doc
// itself, so a doc-write failure can never desync the checkpoint from what was actually read.
export const DIFFS_CHECKPOINT_KEY = 'voice_learn.diffs_checkpoint';

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

    // Checkpoint gate: best-effort, only consulted when entityMemory is wired (same guard
    // style as the dismissal cooldown below) — if unavailable, fall back to the pre-fix
    // behaviour of feeding every accumulated pair rather than failing the run.
    let configStore: ConfigStore | null = null;
    let checkpointMs = NaN;
    if (ctx.entityMemory) {
      configStore = new ConfigStore(ctx.entityMemory, ctx.log);
      const checkpointRaw = await configStore.get(CONFIG_NAMESPACE, DIFFS_CHECKPOINT_KEY);
      checkpointMs = checkpointRaw ? Date.parse(checkpointRaw) : NaN;
    }
    // A pair with an unparsable sentAt fails open (treated as new) so a malformed
    // `- sent_at:` line can never silently drop real evidence from the LLM pass.
    const newPairs = Number.isFinite(checkpointMs)
      ? pairs.filter((p) => {
          const sentAtMs = Date.parse(p.sentAt);
          return !Number.isFinite(sentAtMs) || sentAtMs > checkpointMs;
        })
      : pairs;
    if (newPairs.length === 0) {
      ctx.log.info({}, 'voice-learn: no diffs newer than checkpoint — nothing new to learn');
      return {
        success: true,
        data: { pairs_considered: 0, proposed: false, reason: 'no-new-evidence' },
      };
    }

    // Dedup: skip if a guide proposal is already pending. The diff doc is never
    // consumed, so without this a still-open proposal would get re-proposed weekly.
    // pending-proposals.md is APPEND-ONLY, so use the shared parser invariant rather than a
    // raw regex: a non-null parse means a pending block exists somewhere in the doc even after
    // earlier blocks were approved/dismissed (F1 — the raw regex only saw the FIRST block).
    const existing = await ctx.workingDocs.read(PENDING_PROPOSALS_PATH);
    if (existing && parseVoiceGuideProposal(existing.body) !== null) {
      return {
        success: true,
        data: { pairs_considered: newPairs.length, proposed: false, reason: 'proposal-pending' },
      };
    }

    // Respect the dismissal cooldown the digest writes on `dismiss voice`. Best-effort and
    // additive: only consulted when entityMemory is wired (guarded, not a hard capability), and
    // a missing/garbage record simply doesn't gate. Without this the cooldown was written but
    // never read, so a dismissed guide got re-proposed on the very next weekly run (known-Minor #3).
    // Reuses `configStore` from the checkpoint read above (same guard, same ConfigStore instance)
    // rather than constructing a second one.
    if (configStore) {
      const rawDismissed = await configStore.get(CONFIG_NAMESPACE, DISMISSED_KEY);
      let dismissed: Array<{ dimension: string; until: string }> = [];
      if (rawDismissed) {
        try {
          dismissed = JSON.parse(rawDismissed) as Array<{ dimension: string; until: string }>;
        } catch {
          dismissed = [];
        }
      }
      const guideEntry = dismissed.find((d) => d.dimension === 'guide');
      if (guideEntry && Date.parse(guideEntry.until) > Date.now()) {
        ctx.log.info(
          { until: guideEntry.until },
          'voice-learn: guide dismissal cooldown active — no proposal this run',
        );
        return {
          success: true,
          data: { pairs_considered: newPairs.length, proposed: false, reason: 'dismiss-cooldown' },
        };
      }
    }

    const currentGuide = ctx.executiveProfileService.get().writingVoice.guide ?? '';
    const batch = newPairs.slice(-MAX_PAIRS);
    const res = await ctx.infraLlm.extract(buildVoiceGuidePrompt(currentGuide, batch), {
      maxTokens: 1200,
    });
    if (!res.ok) {
      ctx.log.warn({ error: res.error }, 'voice-learn: LLM failed — no proposal this run');
      return {
        success: true,
        data: { pairs_considered: newPairs.length, proposed: false, reason: 'llm-failed' },
      };
    }

    const guide = res.text.trim();
    if (!guide) {
      return {
        success: true,
        data: { pairs_considered: newPairs.length, proposed: false, reason: 'empty-guide' },
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

    // Advance the checkpoint only now that the proposal write above has succeeded — a failed
    // LLM call or empty guide already returned earlier without reaching here, so those cases
    // correctly leave the checkpoint untouched and the same evidence gets retried next run.
    // Checkpoint = newest sentAt among the pairs actually fed to the LLM (`batch`), not all of
    // `newPairs` — anything beyond MAX_PAIRS wasn't used yet and must stay eligible next run.
    if (configStore) {
      const newestSentAt = batch.reduce<string>((newest, p) => {
        const t = Date.parse(p.sentAt);
        if (!Number.isFinite(t)) return newest;
        return !newest || t > Date.parse(newest) ? p.sentAt : newest;
      }, '');
      if (newestSentAt) {
        await configStore.set(CONFIG_NAMESPACE, DIFFS_CHECKPOINT_KEY, newestSentAt);
      }
    }

    ctx.log.info({ pairs: newPairs.length }, 'voice-learn: proposed an updated guide');
    return { success: true, data: { pairs_considered: newPairs.length, proposed: true } };
  }
}
