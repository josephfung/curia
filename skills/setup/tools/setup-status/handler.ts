// skills/setup-status/handler.ts
//
// The Setup checklist itself is computed in core (src/setup/checklist.ts) so the console's
// Setup page and this tool always agree (#2358). This handler adds the agent-only part:
// optional tasks the operator chose to leave for later (setup-defer).
import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import type { SetupChecklistTask } from '../../../../src/setup/checklist.js';
import { ConfigStore } from '../../../../src/memory/config-store.js';

type TaskStatus = 'done' | 'pending' | 'deferred';

interface TaskWithStatus extends Omit<SetupChecklistTask, 'status'> {
  status: TaskStatus;
}

/** Loads the set of deferred task IDs from the ConfigStore. Returns an empty set
 *  when no deferrals have been stored (or if the stored value is malformed). */
async function loadDeferredSet(ctx: ToolContext): Promise<Set<string>> {
  if (!ctx.entityMemory) return new Set();
  const configStore = new ConfigStore(ctx.entityMemory, ctx.log);
  let stored: string | null;
  try {
    stored = await configStore.get('setup_wizard', 'deferrals');
  } catch (err) {
    // KG read failed — treat as no deferrals rather than aborting the entire
    // status call. Deferred state is non-critical UX. Log at warn so the
    // operator can see the degradation.
    ctx.log.warn({ err }, 'setup-status: failed to read deferrals from config-store — treating as empty');
    return new Set();
  }
  if (!stored) return new Set();
  try {
    const parsed = JSON.parse(stored) as unknown;
    const arr = Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string')
      : [];
    return new Set(arr);
  } catch {
    ctx.log.warn({ stored }, 'setup-status: deferrals value was not valid JSON — treating as empty');
    return new Set();
  }
}

export class SetupStatusHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.setupChecklist) {
      return { success: false, error: 'setup-status requires the setupChecklist capability.' };
    }

    try {
      const [checklist, deferred] = await Promise.all([ctx.setupChecklist(), loadDeferredSet(ctx)]);

      // Only optional extras can be left for later: required steps block Start onboarding,
      // so a deferral stored for one (before #2358 made it required) is ignored.
      const tasks: TaskWithStatus[] = checklist.tasks.map((task) => ({
        ...task,
        status: task.status === 'done' ? 'done' : task.optional && deferred.has(task.id) ? 'deferred' : 'pending',
      }));

      const summary = {
        total: tasks.length,
        done: tasks.filter(t => t.status === 'done').length,
        pending: tasks.filter(t => t.status === 'pending').length,
        deferred: tasks.filter(t => t.status === 'deferred').length,
      };

      return {
        success: true,
        data: { setup_complete: checklist.setupComplete, missing: checklist.missing, tasks, summary },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'setup-status failed');
      return { success: false, error: message };
    }
  }
}
