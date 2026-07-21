// skills/setup-status/handler.ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import { ConfigStore } from '../../src/memory/config-store.js';

// ── Catalog types ──────────────────────────────────────────────────────────

type CompletionCheck =
  | { type: 'behavioral_preferences' }
  | { type: 'scheduler_has_active_debrief' }
  | { type: 'always_available' }
  | { type: 'vault_secrets_all'; keys: string[] };

interface CatalogTask {
  id: string;
  label: string;
  value_prop: string;
  tier: string;
  handoff: 'in-chat' | 'console';
  handoff_path?: string;
  optional?: boolean;
  completion_check: CompletionCheck;
  credential_how_to: string | null;
  docs_url: string | null;
}

type TaskStatus = 'done' | 'pending' | 'deferred';

interface CatalogTaskWithStatus extends Omit<CatalogTask, 'completion_check'> {
  status: TaskStatus;
  // Present for vault_secrets_all tasks — the agent uses keys[0] with system-secret-capture-request.
  vault_keys?: string[];
}

// ── Catalog loading ────────────────────────────────────────────────────────

// Module-level cache — catalog.yaml is static, safe to cache across invocations.
// Tests that need a fresh catalog can use vi.resetModules() if needed.
let catalogCache: CatalogTask[] | null = null;

async function loadCatalog(): Promise<CatalogTask[]> {
  if (catalogCache) return catalogCache;
  const catalogPath = join(import.meta.dirname, 'catalog.yaml');
  const raw = await readFile(catalogPath, 'utf-8');
  // js-yaml v5: yaml.load() is safe by default — arbitrary-type tags (!!python/object etc.)
  // were removed in v5. safeLoad() no longer exists. See js-yaml v5 migration guide.
  const parsed = yaml.load(raw) as unknown;
  // Guard against malformed catalog files — a bad YAML structure should be a loud
  // error that identifies the catalog as the source, not a cryptic TypeError later.
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { tasks?: unknown }).tasks)
  ) {
    throw new Error(
      `setup-status: catalog.yaml parsed to an unexpected structure — expected { tasks: [...] }. Got: ${JSON.stringify(parsed)?.slice(0, 200)}`,
    );
  }
  catalogCache = (parsed as { tasks: CatalogTask[] }).tasks;
  return catalogCache;
}

// ── Helpers ────────────────────────────────────────────────────────────────

// The exact substring the execution layer uses when a declared secret has no value.
// Only this error class should return false — vault infrastructure errors and
// undeclared-key programming errors must propagate.
const SECRET_ABSENT_MSG = 'is declared but not set in the environment';

/** Returns true when the named secret is present in the vault, false otherwise.
 *  ctx.secret() throws when the key is absent — we use try/catch to check presence
 *  without consuming the value. */
function secretPresent(ctx: ToolContext, name: string): boolean {
  try {
    ctx.secret(name);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Only the "key absent" case should return false — vault errors and
    // undeclared-key programming errors must propagate so they surface
    // through the handler's standard error path instead of silently
    // misreporting all credentialed tasks as pending.
    if (message.includes(SECRET_ABSENT_MSG)) {
      return false;
    }
    throw err;
  }
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

// ── Handler ────────────────────────────────────────────────────────────────

export class SetupStatusHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.entityMemory) {
      return { success: false, error: 'setup-status requires entityMemory capability.' };
    }

    try {
      const [tasks, deferred] = await Promise.all([loadCatalog(), loadDeferredSet(ctx)]);

      // Resolve live state once (batched, not per-task) to avoid redundant service calls.
      const behavioralPreferences = ctx.officeIdentityService?.get()?.behavioralPreferences ?? [];
      const personaDone = behavioralPreferences.length > 0;

      let debriefDone = false;
      if (ctx.schedulerService) {
        // Recurring jobs cycle pending→running→pending; 'active' is a task-row status,
        // not a scheduled_jobs status. Fetch all jobs and exclude terminal + hold states instead.
        // 'suspended' = job paused by the scheduler after repeated failures.
        // 'paused' = job paused manually via pauseJobForDrift() or operator action.
        // Both mean the schedule is not running and should not count as "done".
        const TERMINAL_STATUSES = new Set(['cancelled', 'completed', 'failed', 'suspended', 'paused']);
        const jobs = await ctx.schedulerService.listJobs();
        debriefDone = jobs.some(
          j =>
            !TERMINAL_STATUSES.has(j.status ?? '') &&
            j.intentAnchor?.includes('debrief'),
        );
      }

      const annotated: CatalogTaskWithStatus[] = tasks.map(task => {
        let done = false;
        // Cast to include undefined: catalog.yaml is loaded without per-entry validation,
        // so a malformed entry missing completion_check must not throw a TypeError here.
        const check = task.completion_check as CompletionCheck | undefined;

        if (check) {
          switch (check.type) {
            case 'behavioral_preferences':
              done = personaDone;
              break;
            case 'scheduler_has_active_debrief':
              done = debriefDone;
              break;
            case 'always_available':
              done = true;
              break;
            case 'vault_secrets_all':
              done = check.keys.every(k => secretPresent(ctx, k));
              break;
          }
        } else {
          ctx.log.warn({ taskId: task.id }, 'setup-status: task has invalid completion_check — reporting pending');
        }

        // "done" wins over deferred — a completed task is done regardless of deferral.
        const status: TaskStatus = done ? 'done' : deferred.has(task.id) ? 'deferred' : 'pending';

        // Expose vault key names so the agent can pass the correct key to
        // system-secret-capture-request for in-chat credential capture tasks.
        const { completion_check: _check, ...rest } = task;
        const vault_keys = _check?.type === 'vault_secrets_all' ? _check.keys : undefined;
        return vault_keys ? { ...rest, status, vault_keys } : { ...rest, status };
      });

      const summary = {
        total: annotated.length,
        done: annotated.filter(t => t.status === 'done').length,
        pending: annotated.filter(t => t.status === 'pending').length,
        deferred: annotated.filter(t => t.status === 'deferred').length,
      };

      return { success: true, data: { tasks: annotated, summary } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'setup-status failed');
      return { success: false, error: message };
    }
  }
}
