import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
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

export class ResolveLearningDigestHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
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

  private async runResolve(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.taskRepo || !ctx.entityMemory || !ctx.executiveProfileService) {
      return {
        success: false,
        error: 'resolve-learning-digest requires taskRepo, entityMemory, executiveProfileService',
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
      const proposal = await readVoiceProposal(store, ctx.log);
      if (!proposal || proposal.status !== 'pending') {
        return { success: false, error: 'No pending voice guide proposal' };
      }

      if (action === 'approve_voice') {
        const current = ctx.executiveProfileService.get().writingVoice;
        await ctx.executiveProfileService.update(
          { writingVoice: { ...current, guide: proposal.guide } },
          'tool',
          'voice guide approved',
        );

        // Clear the resolved proposal so it doesn't stay "pending" forever — the approved
        // guide now lives in the versioned profile, which is the real audit trail.
        //
        // The primary side effect (the profile write above) already succeeded by this point.
        // If the clear itself soft-rejects (stored:false — a dedup 'conflict'/'auto_rejected'
        // outcome, not a throw), we must NOT report success: the proposal item would still be
        // there next time the digest is listed, contradicting a "resolved: true" response. We
        // surface that honestly instead. A retry is safe because the mutations here are
        // idempotent — re-approving writes the identical guide text again, and re-clearing a
        // proposal that's already gone is a no-op.
        const cleared = await writeVoiceProposal(store, null);
        if (!cleared) {
          return {
            success: false,
            error: 'Voice guide applied to the profile, but the pending proposal could not be cleared (transient) and may reappear — retry to clear it.',
          };
        }
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
      // proposal record itself serves no further purpose. The cooldown write above already
      // landed, so a soft-reject here only means the proposal item may reappear in the digest.
      const cleared = await writeVoiceProposal(store, null);
      if (!cleared) {
        return {
          success: false,
          error: 'Voice guide dismissed (cooldown recorded), but the pending proposal could not be cleared (transient) and may reappear — retry to clear it.',
        };
      }
      return { success: true, data: { resolved: true, detail: 'Dismissed voice guide' } };
    }

    // completion actions
    const taskId = typeof input.task_id === 'string' ? input.task_id.trim() : '';
    if (!taskId) return { success: false, error: 'task_id is required for completion actions' };

    const store = new ConfigStore(ctx.entityMemory, ctx.log);
    const digestMap = await readCompletionDigest(store, ctx.log);
    const item = digestMap[taskId];

    // Require an actionable digest item of the matching kind before mutating a task —
    // otherwise undo/confirm would reopen/complete ANY task id the caller supplies, and
    // still report success even when the digest held no such item.
    const expectedKind = action === 'undo_completion' ? 'undo' : 'confirm';
    if (!item || item.kind !== expectedKind) {
      return { success: false, error: `No actionable ${expectedKind} item for task ${taskId}` };
    }

    if (action === 'undo_completion') {
      // Idempotency guard (mirrors confirm_completion below): reopenTask THROWS on any status other
      // than 'done' (src/db/task-repo.ts). On a replay after a soft-rejected clear, run 1 already
      // reopened the task (done -> open), so calling reopenTask again would throw and wedge the
      // digest item forever. Branch precisely on the status so we never falsely report "Reopened":
      //   - 'done'  : reopen it (the normal path), then clear the item.
      //   - 'open'  : run 1's reopen already landed — converge by clearing the item.
      //   - other   : the task moved on independently (cancelled / failed / in_progress / ...).
      //               Reopening doesn't apply and reporting "Reopened" would be a lie, so fail loud
      //               and KEEP the item (the user can drop it via dismiss_completion).
      // A missing task also fails loud with the item kept, same as the confirm path.
      const task = await ctx.taskRepo.getTask(taskId);
      if (!task) {
        return { success: false, error: `Task ${taskId} not found; cannot undo completion` };
      }
      if (task.status === 'done') {
        const reopened = await ctx.taskRepo.reopenTask(
          taskId,
          'Undo auto-complete from sent mail',
          ctx.agentId,
        );
        // reopenTask returns null when the row vanished / raced to non-done between the read and
        // the UPDATE — fail loud and DON'T consume the digest item, so the undo affordance survives.
        if (!reopened) {
          return { success: false, error: `Task ${taskId} could not be reopened (it may have changed); retry` };
        }
      } else if (task.status !== 'open') {
        // Not 'done' (reopenable) and not 'open' (already reopened by a prior run's undo) — the task
        // is in some other state we didn't cause. Don't clear the item and don't claim a reopen.
        return {
          success: false,
          error: `Task ${taskId} is '${task.status}', not done; cannot undo completion`,
        };
      }
      // status is 'done' (just reopened) or 'open' (already reopened) — clear the digest item. A
      // soft-reject on the clear only means the item may reappear; a retry re-checks status and
      // clears idempotently.
      const { [taskId]: _removed, ...rest } = digestMap;
      void _removed;
      const cleared = await writeCompletionDigest(store, rest);
      if (!cleared) {
        return {
          success: false,
          error: `Task ${taskId} was reopened, but the digest item could not be cleared (transient) and may reappear — retry to clear it.`,
        };
      }
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
      // Task completion (if needed) already happened above; a soft-reject on the clear only
      // means the digest item may reappear — completing an already-done task next retry is a
      // no-op (the `task.status !== 'done'` guard above skips it).
      const { [taskId]: _removed, ...rest } = digestMap;
      void _removed;
      const cleared = await writeCompletionDigest(store, rest);
      if (!cleared) {
        return {
          success: false,
          error: `Task ${taskId} was confirmed complete, but the digest item could not be cleared (transient) and may reappear — retry to clear it.`,
        };
      }
      return { success: true, data: { resolved: true, detail: `Confirmed completion ${taskId}` } };
    }

    // dismiss_completion
    const { [taskId]: _removed, ...rest } = digestMap;
    void _removed;
    const cleared = await writeCompletionDigest(store, rest);
    if (!cleared) {
      return {
        success: false,
        error: `Digest item for task ${taskId} could not be cleared (transient); retry.`,
      };
    }
    return { success: true, data: { resolved: true, detail: `Dismissed completion ${taskId}` } };
  }
}
