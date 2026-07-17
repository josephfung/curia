import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { ConfigStore } from '../../src/memory/config-store.js';
import { CONFIG_NAMESPACE as VOICE_NS, DISMISSED_KEY } from '../voice-learn/handler.js';
import {
  readVoiceProposal,
  writeVoiceProposal,
  readCompletionDigest,
  writeCompletionDigest,
} from '../_shared/learning-state.js';

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
      // Built once — reused for the proposal read/clear below and (on dismiss) the cooldown
      // write, all against the same 'ceo_inbox' namespace.
      const store = new ConfigStore(ctx.entityMemory, ctx.log);
      const proposal = await readVoiceProposal(store);
      if (!proposal || proposal.status !== 'pending') {
        return { success: false, error: 'No pending voice guide proposal' };
      }

      if (action === 'approve_voice') {
        const current = ctx.executiveProfileService.get().writingVoice;
        await ctx.executiveProfileService.update(
          { writingVoice: { ...current, guide: proposal.guide } },
          'skill',
          'voice guide approved',
        );

        // Clear the resolved proposal so it doesn't stay "pending" forever — the approved
        // guide now lives in the versioned profile, which is the real audit trail.
        await writeVoiceProposal(store, null);
        return { success: true, data: { resolved: true, detail: 'Approved voice guide' } };
      }

      // dismiss: keep the existing DISMISSED_KEY cooldown write. There's only one guide
      // dimension now (no per-field proposals), so the cooldown entry uses a fixed key.
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

      // Clear the resolved proposal — the dismiss cooldown is tracked in config, so the
      // proposal record itself serves no further purpose.
      await writeVoiceProposal(store, null);
      return { success: true, data: { resolved: true, detail: 'Dismissed voice guide' } };
    }

    // completion actions
    const taskId = typeof input.task_id === 'string' ? input.task_id.trim() : '';
    if (!taskId) return { success: false, error: 'task_id is required for completion actions' };

    const store = new ConfigStore(ctx.entityMemory, ctx.log);
    const digestMap = await readCompletionDigest(store);
    const item = digestMap[taskId];

    // Require an actionable digest item of the matching kind before mutating a task —
    // otherwise undo/confirm would reopen/complete ANY task id the caller supplies, and
    // still report success even when the digest held no such item.
    const expectedKind = action === 'undo_completion' ? 'undo' : 'confirm';
    if (!item || item.kind !== expectedKind) {
      return { success: false, error: `No actionable ${expectedKind} item for task ${taskId}` };
    }

    if (action === 'undo_completion') {
      // reopenTask returns null when the task no longer exists. Fail loudly and DON'T consume the
      // digest item in that case — mirrors the confirm path's not-found guard below. Otherwise
      // we'd drop the undo affordance and report success while having reopened nothing.
      const reopened = await ctx.taskRepo.reopenTask(
        taskId,
        'Undo auto-complete from sent mail',
        ctx.agentId,
      );
      if (!reopened) {
        return { success: false, error: `Task ${taskId} not found; cannot undo completion` };
      }
      // Remove the actioned item from the config map so resolved items don't accumulate.
      const { [taskId]: _removed, ...rest } = digestMap;
      void _removed;
      await writeCompletionDigest(store, rest);
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
      const { [taskId]: _removed, ...rest } = digestMap;
      void _removed;
      await writeCompletionDigest(store, rest);
      return { success: true, data: { resolved: true, detail: `Confirmed completion ${taskId}` } };
    }

    // dismiss_completion
    const { [taskId]: _removed, ...rest } = digestMap;
    void _removed;
    await writeCompletionDigest(store, rest);
    return { success: true, data: { resolved: true, detail: `Dismissed completion ${taskId}` } };
  }
}
