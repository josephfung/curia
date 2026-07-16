import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { ConfigStore } from '../../src/memory/config-store.js';
import {
  CONFIG_NAMESPACE as VOICE_NS,
  DISMISSED_KEY,
  PENDING_PROPOSALS_PATH,
} from '../voice-learn/handler.js';
import { COMPLETION_DIGEST_PATH } from '../task-completion-from-sent/handler.js';
import {
  markCompletionStatus,
  markGuideProposalStatus,
  parseCompletionDigest,
  parseVoiceGuideProposal,
} from '../_shared/learning-digest.js';

const ACTIONS = new Set([
  'approve_voice',
  'dismiss_voice',
  'undo_completion',
  'confirm_completion',
  'dismiss_completion',
]);

export class ResolveLearningDigestHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    // Skill contract: never throw — a rejected profile/config/task/document call becomes
    // a failure result rather than escaping the handler.
    try {
      return await this.runResolve(ctx);
    } catch (err) {
      ctx.log.error({ err }, 'resolve-learning-digest: unexpected failure');
      return {
        success: false,
        error: `resolve-learning-digest failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async runResolve(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.workingDocs || !ctx.taskRepo || !ctx.entityMemory || !ctx.executiveProfileService) {
      return {
        success: false,
        error: 'resolve-learning-digest requires workingDocs, taskRepo, entityMemory, executiveProfileService',
      };
    }

    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};
    const action = typeof input.action === 'string' ? input.action : '';
    if (!ACTIONS.has(action)) {
      return {
        success: false,
        error: `action must be one of: ${[...ACTIONS].join(', ')}`,
      };
    }

    if (action === 'approve_voice' || action === 'dismiss_voice') {
      const doc = await ctx.workingDocs.read(PENDING_PROPOSALS_PATH);
      const proposal = doc ? parseVoiceGuideProposal(doc.body) : null;
      if (!doc || !proposal) return { success: false, error: 'No pending voice guide proposal' };

      if (action === 'approve_voice') {
        const current = ctx.executiveProfileService.get().writingVoice;
        await ctx.executiveProfileService.update(
          { writingVoice: { ...current, guide: proposal.guide } },
          'skill',
          'voice guide approved',
        );

        const updatedBody = markGuideProposalStatus(doc.body, 'approved');
        await ctx.workingDocs.update(PENDING_PROPOSALS_PATH, {
          body: updatedBody,
          expectedVersion: doc.version,
        });
        return { success: true, data: { resolved: true, detail: 'Approved voice guide' } };
      }

      // dismiss: keep the existing DISMISSED_KEY cooldown write. There's only one guide
      // dimension now (no per-field proposals), so the cooldown entry uses a fixed key.
      const store = new ConfigStore(ctx.entityMemory, ctx.log);
      const rawDismissed = await store.get(VOICE_NS, DISMISSED_KEY);
      let dismissed: Array<{ dimension: string; until: string }> = [];
      if (rawDismissed) {
        try {
          dismissed = JSON.parse(rawDismissed) as Array<{ dimension: string; until: string }>;
        } catch {
          dismissed = [];
        }
      }
      const until = new Date(Date.now() + 30 * 86_400_000).toISOString();
      dismissed = dismissed.filter((d) => d.dimension !== 'guide');
      dismissed.push({ dimension: 'guide', until });
      await store.set(VOICE_NS, DISMISSED_KEY, JSON.stringify(dismissed));

      const updatedBody = markGuideProposalStatus(doc.body, 'dismissed');
      await ctx.workingDocs.update(PENDING_PROPOSALS_PATH, {
        body: updatedBody,
        expectedVersion: doc.version,
      });
      return { success: true, data: { resolved: true, detail: 'Dismissed voice guide' } };
    }

    // completion actions
    const taskId = typeof input.task_id === 'string' ? input.task_id.trim() : '';
    if (!taskId) return { success: false, error: 'task_id is required for completion actions' };

    const digest = await ctx.workingDocs.read(COMPLETION_DIGEST_PATH);
    if (!digest) return { success: false, error: 'No completion digest items' };

    // Require an actionable digest item of the matching kind before mutating a task —
    // otherwise undo/confirm would reopen/complete ANY task id the caller supplies, and
    // still report success even when markCompletionStatus changed nothing.
    const expectedKind = action === 'undo_completion' ? 'undo' : 'confirm';
    const item = parseCompletionDigest(digest.body).find(
      (candidate) => candidate.taskId === taskId && candidate.kind === expectedKind,
    );
    if (!item) {
      return { success: false, error: `No actionable ${expectedKind} item for task ${taskId}` };
    }

    if (action === 'undo_completion') {
      await ctx.taskRepo.reopenTask(taskId, 'Undo auto-complete from sent mail', ctx.agentId);
      const updatedBody = markCompletionStatus(digest.body, 'Undo', taskId, 'undone');
      await ctx.workingDocs.update(COMPLETION_DIGEST_PATH, {
        body: updatedBody,
        expectedVersion: digest.version,
      });
      return { success: true, data: { resolved: true, detail: `Reopened task ${taskId}` } };
    }

    if (action === 'confirm_completion') {
      const task = await ctx.taskRepo.getTask(taskId);
      // Fail loudly when the task no longer exists — otherwise we'd mark the digest
      // "confirmed" and report success while completing nothing.
      if (!task) {
        return { success: false, error: `Task ${taskId} not found; cannot confirm completion` };
      }
      if (task.status !== 'done') {
        await ctx.taskRepo.completeTask(
          taskId,
          'Confirmed complete from sent-mail digest',
          ctx.agentId,
        );
      }
      const updatedBody = markCompletionStatus(digest.body, 'Confirm', taskId, 'confirmed');
      await ctx.workingDocs.update(COMPLETION_DIGEST_PATH, {
        body: updatedBody,
        expectedVersion: digest.version,
      });
      return { success: true, data: { resolved: true, detail: `Confirmed completion ${taskId}` } };
    }

    // dismiss_completion
    const updatedBody = markCompletionStatus(digest.body, 'Confirm', taskId, 'dismissed');
    await ctx.workingDocs.update(COMPLETION_DIGEST_PATH, {
      body: updatedBody,
      expectedVersion: digest.version,
    });
    return { success: true, data: { resolved: true, detail: `Dismissed completion ${taskId}` } };
  }
}
