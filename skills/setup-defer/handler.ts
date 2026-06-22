// skills/setup-defer/handler.ts
//
// Writes/clears deferral flags in config-store. A deferred task's id is stored
// as a JSON array under setup_wizard/deferrals. Rewriting the whole array on
// each call sidesteps config-store's no-delete limitation.
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { ConfigStore } from '../../src/memory/config-store.js';

// Config-store namespace and key for wizard deferrals — matches what
// setup-status reads to determine which tasks are deferred.
const NAMESPACE = 'setup_wizard';
const KEY = 'deferrals';

export class SetupDeferHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.entityMemory) {
      return { success: false, error: 'setup-defer requires entityMemory capability.' };
    }

    const { task_id, action } = ctx.input as { task_id?: unknown; action?: unknown };

    if (typeof task_id !== 'string' || !task_id.trim()) {
      return { success: false, error: 'task_id must be a non-empty string.' };
    }
    if (action !== 'defer' && action !== 'resume') {
      return { success: false, error: 'action must be "defer" or "resume".' };
    }

    const configStore = new ConfigStore(ctx.entityMemory, ctx.log);

    try {
      const stored = await configStore.get(NAMESPACE, KEY);
      let deferred: string[] = [];
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as unknown;
          deferred = Array.isArray(parsed)
            ? parsed.filter((x): x is string => typeof x === 'string')
            : [];
        } catch {
          // Stored value was corrupted — reset to empty and continue. Log a warning
          // so operators can investigate if this happens unexpectedly in production.
          ctx.log.warn({ stored }, 'setup-defer: deferrals value was not valid JSON — resetting to empty');
        }
      }

      if (action === 'defer') {
        // Idempotent: only add the task_id if it isn't already in the list
        if (!deferred.includes(task_id)) {
          deferred = [...deferred, task_id];
        }
      } else {
        // action === 'resume': remove the task_id from the list
        deferred = deferred.filter(id => id !== task_id);
      }

      await configStore.set(NAMESPACE, KEY, JSON.stringify(deferred));

      return {
        success: true,
        data: {
          task_id,
          action,
          deferred,
          summary:
            action === 'defer'
              ? `"${task_id}" deferred. ${deferred.length} task(s) deferred total.`
              : `"${task_id}" removed from deferrals. ${deferred.length} task(s) deferred remaining.`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'setup-defer failed');
      return { success: false, error: message };
    }
  }
}
