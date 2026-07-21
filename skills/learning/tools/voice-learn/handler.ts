// voice-learn — weekly WritingVoice refinement from (draft, sent) diffs (#1423).
//
// Replaces the old heuristic scoring/threshold/provenance machinery with a single
// batched LLM pass: read the accumulated diffs, ask the model for an updated
// free-form guide, and queue it as a "Guide Proposal" for the CEO to approve via
// the digest. This handler never writes the profile directly — human-in-the-loop.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { ConfigStore } from '../../../../src/memory/config-store.js';
import { buildVoiceGuidePrompt, parsePendingDiffs } from '../../../_shared/voice-learn-logic.js';
import { PENDING_DIFFS_PATH } from '../ceo-inbox-sent-observe/handler.js';
import { writeVoiceProposal } from '../../../_shared/learning-state.js';
import { buildVoiceProposalNotification } from '../../../_shared/learning-digest.js';
import { notifyLearningProposal } from '../../../_shared/learning-notify.js';

// Kept for Task 9 (resolve-learning-digest) and cooldown bookkeeping, even though
// this handler no longer reads/writes provenance directly.
export const DISMISSED_KEY = 'voice_learn.dismissed';
export const CONFIG_NAMESPACE = 'ceo_inbox';

// Checkpoint (ISO timestamp string) marking the newest `sentAt` among diff pairs already fed
// to the LLM. pending-diffs.md is rolling/append-only and never consumed, so without this the
// weekly run would re-feed the SAME evidence forever — even after a proposal was approved or
// dismissed — and propose essentially the same guide again (CodeRabbit finding #11). Stored via
// ConfigStore (best-effort — see the ctx.entityMemory guard below), NOT as part of the diff doc
// itself, so a doc-write failure can never desync the checkpoint from what was actually read.
export const DIFFS_CHECKPOINT_KEY = 'voice_learn.diffs_checkpoint';

/** Max diff pairs fed into a single LLM guide-refinement call. The OLDEST eligible pairs are
 *  taken (see the batch selection below), bounding prompt size/cost while draining any backlog
 *  oldest-first across runs so nothing is stranded past the checkpoint. */
const MAX_PAIRS = 40;

export class VoiceLearnHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
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

  private async runLearn(ctx: ToolContext): Promise<ToolResult> {
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
      try {
        const checkpointRaw = await configStore.get(CONFIG_NAMESPACE, DIFFS_CHECKPOINT_KEY);
        checkpointMs = checkpointRaw ? Date.parse(checkpointRaw) : NaN;
      } catch (err) {
        // Genuinely best-effort: ConfigStore.get propagates infra failures, so a checkpoint-store
        // outage must be swallowed here — otherwise it escapes to the outer catch and fails the
        // whole run. Fall back to feeding every accumulated pair (checkpointMs stays NaN).
        ctx.log.warn({ err }, 'voice-learn: checkpoint read failed — proceeding without checkpoint filter');
      }
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

    // Respect the dismissal cooldown the digest writes on `dismiss voice`. Best-effort and
    // additive: only consulted when entityMemory is wired (guarded, not a hard capability), and
    // a missing/garbage record simply doesn't gate. Without this the cooldown was written but
    // never read, so a dismissed guide got re-proposed on the very next weekly run (known-Minor #3).
    // Reuses `configStore` from the checkpoint read above (same guard, same ConfigStore instance)
    // rather than constructing a second one.
    if (configStore) {
      let rawDismissed: string | null = null;
      try {
        rawDismissed = await configStore.get(CONFIG_NAMESPACE, DISMISSED_KEY);
      } catch (err) {
        // Best-effort, same rationale as the checkpoint read: a store outage must not fail the
        // run. Without a cooldown record we simply don't gate — worst case a dismissed guide is
        // re-proposed one run early, which is far better than aborting learning entirely.
        ctx.log.warn({ err }, 'voice-learn: dismissal read failed — not gating on cooldown this run');
      }
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
    // Process the OLDEST eligible pairs, not the newest. The checkpoint below advances to this
    // batch's newest sentAt, so every pair we leave out must be NEWER than everything we processed
    // — otherwise an excluded pair would fall at/under the new checkpoint and be dropped forever
    // (the bug with the old `slice(-MAX_PAIRS)`, which processed the newest and stranded the rest).
    // Sort ascending by sentAt first because the diff doc is not globally ordered: each run appends
    // a newest-first block, so document order alone wouldn't put the oldest pairs at the front.
    // Unparsable sentAt sorts oldest so a malformed line is attempted, never used to gate the batch.
    const batch = [...newPairs]
      .sort((a, b) => {
        const ta = Date.parse(a.sentAt);
        const tb = Date.parse(b.sentAt);
        return (Number.isFinite(ta) ? ta : -Infinity) - (Number.isFinite(tb) ? tb : -Infinity);
      })
      .slice(0, MAX_PAIRS);
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

    // Supersede any prior proposal by writing the single proposal object whole. The checkpoint
    // (below) is what stops the SAME evidence being re-proposed; this write replaces a stale
    // still-pending proposal with the fresher one. configStore is guaranteed here — a proposal
    // requires entityMemory to persist state; if it's unavailable we cannot record the proposal.
    if (!configStore) {
      ctx.log.warn({}, 'voice-learn: config store unavailable — cannot record proposal this run');
      return {
        success: true,
        data: { pairs_considered: newPairs.length, proposed: false, reason: 'no-config-store' },
      };
    }
    const proposalStored = await writeVoiceProposal(configStore, {
      status: 'pending',
      generatedAt: new Date().toISOString(),
      guide,
    });
    if (!proposalStored) {
      // Soft-reject (stored:false, no thrown error) — do NOT advance the checkpoint below, or
      // this evidence would never be retried and the proposal would simply vanish. Returning
      // early here (before the checkpoint-advance block) is what keeps this batch eligible on
      // the next run.
      ctx.log.warn(
        {},
        'voice-learn: proposal write soft-rejected — not advancing checkpoint so evidence retries',
      );
      return {
        success: true,
        data: { pairs_considered: newPairs.length, proposed: false, reason: 'proposal-not-persisted' },
      };
    }

    // Advance the checkpoint only now that the proposal write above has succeeded — a failed
    // LLM call or empty guide already returned earlier without reaching here, so those cases
    // correctly leave the checkpoint untouched and the same evidence gets retried next run.
    // Checkpoint = newest sentAt among the pairs actually fed to the LLM (`batch` = the oldest
    // MAX_PAIRS), not all of `newPairs` — anything beyond MAX_PAIRS is strictly newer and must
    // stay eligible next run.
    if (configStore) {
      const newestSentAt = batch.reduce<string>((newest, p) => {
        const t = Date.parse(p.sentAt);
        if (!Number.isFinite(t)) return newest;
        return !newest || t > Date.parse(newest) ? p.sentAt : newest;
      }, '');
      if (newestSentAt) {
        try {
          await configStore.set(CONFIG_NAMESPACE, DIFFS_CHECKPOINT_KEY, newestSentAt);
        } catch (err) {
          // Best-effort: the proposal is already written, so a failed checkpoint write only means
          // this batch may be reconsidered next run — the write-time prune/supersede keeps that
          // from producing a duplicate proposal. Never fail the run after a successful proposal.
          ctx.log.warn({ err }, 'voice-learn: checkpoint write failed — batch may be reconsidered next run');
        }
      }
    }

    // Surface the proposal to the CEO the moment it's durably written (#1466). After #1464 removed
    // the scheduled digest, this event-driven notification is the only path that reaches the CEO
    // for approve/dismiss. Best-effort: notifyLearningProposal never throws and never fails the run
    // (the proposal is already persisted above). `guide` is guaranteed non-empty here — the
    // empty-guide case returned earlier.
    await notifyLearningProposal(ctx, buildVoiceProposalNotification(guide));

    ctx.log.info({ pairs: newPairs.length }, 'voice-learn: proposed an updated guide');
    return { success: true, data: { pairs_considered: newPairs.length, proposed: true } };
  }
}
