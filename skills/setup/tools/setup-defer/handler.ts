// skills/setup-defer/handler.ts
//
// Writes/clears deferral flags in config-store. A deferred task's id is stored
// as a JSON array under setup_wizard/deferrals. Rewriting the whole array on
// each call sidesteps config-store's no-delete limitation.
import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { ConfigStore } from '../../../../src/memory/config-store.js';

// Config-store namespace and key for wizard deferrals — matches what
// setup-status reads to determine which tasks are deferred.
const NAMESPACE = 'setup_wizard';
const KEY = 'deferrals';

// Canonical task IDs from catalog.yaml. Validated here so out-of-catalog
// deferrals fail fast rather than silently being stored and never matched.
// Keep in sync with skills/setup/tools/setup-status/catalog.yaml when tasks are added/removed.
const VALID_TASK_IDS = new Set([
  'persona',
  'debrief',
  'capability_tour',
  'email',
  'signal',
  'web_research',
  'kg_memory',
]);

export class SetupDeferHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.entityMemory) {
      return { success: false, error: 'setup-defer requires entityMemory capability.' };
    }

    const { task_id, action } = ctx.input as { task_id?: unknown; action?: unknown };

    // Normalize whitespace before any comparison or storage — " email " and "email"
    // must be treated identically so deferrals stored here match what setup-status reads.
    const tid = typeof task_id === 'string' ? task_id.trim() : null;

    if (!tid) {
      return { success: false, error: 'task_id must be a non-empty string.' };
    }
    if (!VALID_TASK_IDS.has(tid)) {
      return {
        success: false,
        error: `task_id must be one of: ${[...VALID_TASK_IDS].join(', ')}.`,
      };
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
        // Idempotent: only add the normalized id if it isn't already in the list
        if (!deferred.includes(tid)) {
          deferred = [...deferred, tid];
        }
      } else {
        // action === 'resume': remove the normalized id from the list
        deferred = deferred.filter(id => id !== tid);
      }

      // ConfigStore.set can soft-reject (stored:false) without throwing on a storeFact dedup
      // conflict (#1438). If that happens here the deferrals array did NOT persist, so setup-status
      // would keep reading the prior value and the CEO's defer/resume is silently lost. Report a
      // retryable failure rather than claiming success on a write that never landed.
      const { stored: didStore } = await configStore.set(NAMESPACE, KEY, JSON.stringify(deferred));
      if (!didStore) {
        ctx.log.warn({ task_id: tid, action }, 'setup-defer: deferrals write soft-rejected — change not persisted');
        return {
          success: false,
          error: `Could not persist the deferral change for "${tid}" (transient) — please retry.`,
        };
      }

      return {
        success: true,
        data: {
          task_id: tid,
          action,
          deferred,
          summary:
            action === 'defer'
              ? `"${tid}" deferred. ${deferred.length} task(s) deferred total.`
              : `"${tid}" removed from deferrals. ${deferred.length} task(s) deferred remaining.`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'setup-defer failed');
      return { success: false, error: message };
    }
  }
}
