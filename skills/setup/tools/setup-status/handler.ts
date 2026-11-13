// skills/setup-status/handler.ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import type { ToolHandler, ToolContext, ToolResult, EmailChannelStatus, PrincipalMailboxReadiness } from '../../../../src/skills/types.js';
import { ConfigStore } from '../../../../src/memory/config-store.js';
import { DEFAULT_MAILBOX, legacyDefaultMailbox, readSendLevelValue, type SendLevelMailbox } from '../../../../src/skills/principal-send/send-level.js';

// ── Catalog types ──────────────────────────────────────────────────────────

type CompletionCheck =
  | { type: 'behavioral_preferences' }
  | { type: 'scheduler_has_active_debrief' }
  | { type: 'always_available' }
  | { type: 'principal_profile' }
  | { type: 'vault_secrets_all'; keys: string[] }
  | { type: 'paired_push_subscription' }
  | { type: 'email_channel_ready' }
  // At least one live principal mailbox whose last health canary passed (#2475).
  | { type: 'principal_mailbox_ready' }
  | { type: 'browser_ready' }
  // Done once ConfigStore holds a non-empty value for the key (#2474). Presence only: the
  // setting has a working default, so "set" means the principal has made a choice.
  // `valid_as` also requires the value to hold a real choice: `{}` or malformed JSON reads as
  // the default, so it is not done.
  | { type: 'config_store_set'; namespace: string; key: string; valid_as?: 'send_level' };

/** A credential that improves a task that already works without it (#2445). Setup never
 *  asks for it; the wizard offers it on request. */
interface OptionalUpgrade {
  keys: string[];
  value_prop: string;
  credential_how_to: string;
}

interface CatalogTask {
  id: string;
  label: string;
  value_prop: string;
  tier: string;
  handoff: 'in-chat' | 'console';
  handoff_path?: string;
  optional?: boolean;
  completion_check: CompletionCheck;
  optional_upgrade?: OptionalUpgrade;
  credential_how_to: string | null;
  docs_url: string | null;
}

type TaskStatus = 'done' | 'pending' | 'deferred';

interface CatalogTaskWithStatus extends Omit<CatalogTask, 'completion_check' | 'optional_upgrade'> {
  status: TaskStatus;
  // Present for vault_secrets_all tasks — the agent uses keys[0] with system-secret-capture-request.
  vault_keys?: string[];
  // Present (true) when the task is configured but only takes effect after a restart.
  restart_required?: true;
  // Present for vault_secrets_all tasks: their `done` means the keys are saved, not that the
  // channel or integration is enabled and running (only email checks that, #2409).
  done_means?: 'credentials_saved';
  // Present when the task has an optional upgrade. `configured` is true once every key is set.
  optional_upgrade?: { vault_keys: string[]; configured: boolean; value_prop: string; credential_how_to: string };
}

// ── Catalog loading ────────────────────────────────────────────────────────

// Module-level cache — catalog.yaml is static, safe to cache across invocations.
// Tests that need a fresh catalog can use vi.resetModules() if needed.
let catalogCache: CatalogTask[] | null = null;

/** The `valid_as` values a config_store_set check understands (#2474). */
const CONFIG_VALID_AS: readonly string[] = ['send_level'];

async function loadCatalog(): Promise<CatalogTask[]> {
  if (catalogCache) return catalogCache;
  const catalogPath = join(import.meta.dirname, 'catalog.yaml');
  catalogCache = parseCatalog(await readFile(catalogPath, 'utf-8'));
  return catalogCache;
}

/**
 * catalog.yaml's tasks. Throws on a bad structure, and on a config_store_set check whose
 * `valid_as` is unknown (#2474 final fixes B3): a typo there would otherwise fall back to
 * presence-only and count `{}` as a choice. Exported for the catalog's own tests.
 */
export function parseCatalog(raw: string): CatalogTask[] {
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
  const tasks = (parsed as { tasks: CatalogTask[] }).tasks;
  for (const task of tasks) {
    const check = task.completion_check as { type?: unknown; valid_as?: unknown } | undefined;
    if (check?.type === 'config_store_set' && check.valid_as !== undefined && !CONFIG_VALID_AS.includes(String(check.valid_as))) {
      throw new Error(`setup-status: catalog.yaml task ${task.id} has an unknown valid_as '${String(check.valid_as)}' — expected one of ${CONFIG_VALID_AS.join(', ')}`);
    }
  }
  return tasks;
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

      // The principal's pronouns are the marker for "told Curia how to refer to me": the
      // preferred name and title have working defaults, pronouns do not (#2226). A failed
      // lookup reads as pending rather than failing the whole status call.
      let profileDone = false;
      if (ctx.contactService) {
        try {
          const principal = await ctx.contactService.findContactBySystemRole('principal');
          profileDone = !!principal?.pronouns?.trim();
        } catch (err) {
          ctx.log.warn({ err }, 'setup-status: principal profile lookup failed — reporting pending');
        }
      }

      let phoneReady = false;
      if (ctx.phoneAppReady) {
        try {
          phoneReady = await ctx.phoneAppReady();
        } catch (err) {
          ctx.log.warn({ err }, 'setup-status: phone app check failed — reporting pending');
        }
      }

      // Done only when an email adapter is polling (#2409). Configured-and-enabled after boot
      // reads as pending with restart_required, so "done" never precedes a running mailbox.
      let emailStatus: EmailChannelStatus = 'not_configured';
      if (ctx.emailChannelStatus) {
        try {
          emailStatus = await ctx.emailChannelStatus();
        } catch (err) {
          ctx.log.warn({ err }, 'setup-status: email channel check failed — reporting pending');
        }
      }

      // Done when a live principal mailbox in the registry passed its last health canary
      // (#2475). Calendar reads each mailbox's grant per call, so no restart is ever needed.
      let principalMailboxStatus: PrincipalMailboxReadiness = 'pending';
      if (ctx.principalMailboxReady) {
        try {
          principalMailboxStatus = await ctx.principalMailboxReady();
        } catch (err) {
          ctx.log.warn({ err }, 'setup-status: principal mailbox check failed — reporting pending');
        }
      }

      // Done while a browser is attached: a container that is down reads as pending (#2541).
      const browserReady = ctx.browserService?.browserContext != null;

      // config_store_set tasks: read each distinct namespace/key once (#2474). A failed read
      // reports pending and logs, like the other live checks: setup state is non-critical UX.
      const configSet = new Map<string, boolean>();
      const configStore = new ConfigStore(ctx.entityMemory, ctx.log);
      for (const task of tasks) {
        const c = task.completion_check as CompletionCheck | undefined;
        if (c?.type !== 'config_store_set') continue;
        const id = `${c.namespace}/${c.key}`;
        if (configSet.has(id)) continue;
        try {
          const value = await configStore.get(c.namespace, c.key);
          let set = typeof value === 'string' && value.trim() !== '';
          if (set && c.valid_as === 'send_level') {
            // A level counts only when a live mailbox's id, or a `default` key while it still
            // applies (the migrated sole mailbox, B5/SF6), names a valid one (#2475):
            // readSendLevelValue's fallback for {} or junk is on_request, which no one chose.
            if (readSendLevelValue(value, '').malformed) {
              // Not a JSON object: guarded before any parse here (SF13). Never the value itself.
              ctx.log.warn({ namespace: c.namespace, key: c.key }, 'setup-status: the send level setting is malformed — reporting pending');
              set = false;
            } else {
              // Unknown (no registry wired, or the list failed): the default key is counted.
              let live: SendLevelMailbox[] | undefined;
              try {
                if (ctx.mailboxDirectory) live = await ctx.mailboxDirectory.list();
              } catch (err) {
                ctx.log.warn({ errName: err instanceof Error ? err.name : typeof err }, 'setup-status: could not list mailboxes for the send level — counting the default key only');
              }
              const legacy = live === undefined ? null : legacyDefaultMailbox(live);
              const keys = Object.keys(JSON.parse(value as string) as object);
              set = keys.some((k) => (k === DEFAULT_MAILBOX ? live === undefined || legacy !== null : live?.some((m) => m.id === k) === true)
                && !readSendLevelValue(value, k).malformed);
            }
          }
          configSet.set(id, set);
        } catch (err) {
          ctx.log.warn(
            { err, namespace: c.namespace, key: c.key },
            'setup-status: failed to read config-store setting — reporting pending',
          );
          configSet.set(id, false);
        }
      }

      const annotated: CatalogTaskWithStatus[] = tasks.map(task => {
        let done = false;
        let restartRequired = false;
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
            case 'principal_profile':
              done = profileDone;
              break;
            case 'vault_secrets_all':
              done = check.keys.every(k => secretPresent(ctx, k));
              break;
            case 'paired_push_subscription':
              done = phoneReady;
              break;
            case 'email_channel_ready':
              done = emailStatus === 'running';
              restartRequired = emailStatus === 'restart_required';
              break;
            case 'principal_mailbox_ready':
              done = principalMailboxStatus === 'ready';
              break;
            case 'browser_ready':
              done = browserReady;
              break;
            case 'config_store_set':
              done = configSet.get(`${check.namespace}/${check.key}`) ?? false;
              break;
          }
        } else {
          ctx.log.warn({ taskId: task.id }, 'setup-status: task has invalid completion_check — reporting pending');
        }

        // "done" wins over deferred — a completed task is done regardless of deferral.
        const status: TaskStatus = done ? 'done' : deferred.has(task.id) ? 'deferred' : 'pending';

        // Expose vault key names so the agent can pass the correct key to
        // system-secret-capture-request for in-chat credential capture tasks.
        const { completion_check: _check, optional_upgrade: upgrade, ...rest } = task;
        const vault_keys = _check?.type === 'vault_secrets_all' ? _check.keys : undefined;
        const annotatedTask: CatalogTaskWithStatus = {
          ...rest,
          status,
          ...(vault_keys ? { vault_keys, done_means: 'credentials_saved' as const } : {}),
          ...(restartRequired ? { restart_required: true as const } : {}),
        };
        if (upgrade) {
          annotatedTask.optional_upgrade = {
            vault_keys: upgrade.keys,
            configured: upgrade.keys.every(k => secretPresent(ctx, k)),
            value_prop: upgrade.value_prop,
            credential_how_to: upgrade.credential_how_to,
          };
        }
        return annotatedTask;
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
