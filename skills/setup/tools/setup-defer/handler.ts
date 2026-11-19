// skills/setup-defer/handler.ts
//
// Writes/clears deferral flags in config-store. A deferred task's id is stored
// as a JSON array under setup_wizard/deferrals. Rewriting the whole array on
// each call sidesteps config-store's no-delete limitation.
import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { join } from 'node:path';
import { ConfigStore } from '../../../../src/memory/config-store.js';
import { loadCatalog } from '../../../../src/setup/checklist.js';

// Config-store namespace and key for wizard deferrals — matches what
// setup-status reads to determine which tasks are deferred.
const NAMESPACE = 'setup_wizard';
const KEY = 'deferrals';

// The Setup checklist's catalog (#2358). Only optional extras can be left for later:
// required steps block Start onboarding. Read from the catalog itself so the ids can't drift.
const CATALOG_PATH = join(import.meta.dirname, '../setup-status/catalog.yaml');

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
    if (action !== 'defer' && action !== 'resume') {
      return { success: false, error: 'action must be "defer" or "resume".' };
    }

    let catalog;
    try {
      catalog = await loadCatalog(CATALOG_PATH);
    } catch (err) {
      ctx.log.error({ err }, 'setup-defer: could not read the setup catalog');
      return { success: false, error: 'Could not read the setup catalog.' };
    }
    const task = catalog.find((t) => t.id === tid);
    const optionalIds = catalog.filter((t) => t.optional).map((t) => t.id);
    if (task && !task.optional) {
      return {
        success: false,
        error: `"${tid}" is a required step: it can't be deferred, because Start onboarding stays locked until it is done. Optional extras that can be: ${optionalIds.join(', ')}.`,
      };
    }
    if (!task) {
      return { success: false, error: `task_id must be one of: ${optionalIds.join(', ')}.` };
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
      // would keep reading the prior value and the principal's defer/resume is silently lost. Report a
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
