// checklist.ts — the Setup checklist, computed once for the console's Setup page and the
// setup agent's setup-status tool (#2358). The catalog itself stays in
// skills/setup/tools/setup-status/catalog.yaml; this module parses it and runs each
// task's live check against the dependencies the caller wires in.

import { readFile } from 'node:fs/promises';
import * as yaml from 'js-yaml';
import type { Logger } from '../logger.js';
import type { EmailChannelStatus, PrincipalMailboxReadiness } from '../skills/types.js';
import type { NylasSignInReadiness } from '../nylas/signin-readiness.js';
import type { MessagingRoute, SetupState, VoiceRoute } from './setup-state.js';

// ── Catalog ────────────────────────────────────────────────────────────────

export type CompletionCheck =
  // Step 1: who Setup is for, and the principal's name, email and timezone.
  | { type: 'principal_basics' }
  // Step 2: Curia's name and signature saved from the console.
  | { type: 'office_identity_configured' }
  | { type: 'email_channel_ready' }
  // Step 4: the chosen messaging route works (credentials, channel running, the principal's id).
  | { type: 'messaging_route_ready' }
  // Step 5: the chosen voice route works.
  | { type: 'voice_route_ready' }
  // Mailbox sign-in through Nylas is usable: key, https origin, callback and Google connector (#2361).
  | { type: 'nylas_signin_ready' }
  // At least one live principal mailbox whose last health canary passed (#2475).
  | { type: 'principal_mailbox_ready' }
  | { type: 'browser_ready' }
  | { type: 'vault_secrets_all'; keys: string[] }
  | { type: 'always_available' };

const CHECK_TYPES: ReadonlySet<string> = new Set([
  'principal_basics', 'office_identity_configured', 'email_channel_ready', 'messaging_route_ready',
  'voice_route_ready', 'nylas_signin_ready', 'principal_mailbox_ready', 'browser_ready',
  'vault_secrets_all', 'always_available',
]);

/** A credential that improves a task that already works without it (#2445). */
export interface OptionalUpgrade {
  keys: string[];
  value_prop: string;
  credential_how_to: string;
}

export interface CatalogTask {
  id: string;
  label: string;
  value_prop: string;
  tier: string;
  handoff: 'in-chat' | 'console';
  handoff_path?: string;
  /** Optional extras never block setup_complete. Everything else is required. */
  optional?: boolean;
  completion_check: CompletionCheck;
  optional_upgrade?: OptionalUpgrade;
  credential_how_to: string | null;
  docs_url: string | null;
}

/**
 * catalog.yaml's tasks. Throws on a bad structure or an unknown check type: a typo there
 * would otherwise leave a required step pending forever with nothing saying why.
 */
export function parseCatalog(raw: string): CatalogTask[] {
  // js-yaml v5: yaml.load() is safe by default (arbitrary-type tags were removed in v5).
  const parsed = yaml.load(raw) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { tasks?: unknown }).tasks)
  ) {
    throw new Error(
      `setup catalog parsed to an unexpected structure — expected { tasks: [...] }. Got: ${JSON.stringify(parsed)?.slice(0, 200)}`,
    );
  }
  const tasks = (parsed as { tasks: CatalogTask[] }).tasks;
  const seen = new Set<string>();
  for (const task of tasks) {
    const check = task.completion_check as { type?: unknown } | undefined;
    if (!check || !CHECK_TYPES.has(String(check.type))) {
      throw new Error(`setup catalog task ${task.id} has an unknown completion_check type '${String(check?.type)}'`);
    }
    if (seen.has(task.id)) throw new Error(`setup catalog has a duplicate task id '${task.id}'`);
    seen.add(task.id);
  }
  return tasks;
}

export async function loadCatalog(path: string): Promise<CatalogTask[]> {
  return parseCatalog(await readFile(path, 'utf-8'));
}

// ── Live checks ────────────────────────────────────────────────────────────

/** A channel adapter's state this boot, from the registry row and the boot snapshot. */
export type ChannelRunStatus = 'running' | 'restart_required' | 'not_configured';

export type RouteChannel = 'signal' | 'sms' | 'slack' | 'voice';

export interface SetupCheckDeps {
  state: () => Promise<SetupState>;
  /** The principal contact's step-1 fields, or null when there is no principal yet. */
  principal: () => Promise<{ displayName: string; primaryEmail: string | null; timezone: string | null } | null>;
  identityConfigured: () => Promise<boolean>;
  emailChannelStatus: () => Promise<EmailChannelStatus>;
  nylasSignInReadiness: () => Promise<NylasSignInReadiness>;
  principalMailboxReady: () => Promise<PrincipalMailboxReadiness>;
  channelStatus: (channel: RouteChannel) => Promise<ChannelRunStatus>;
  /** The principal has a verified identity on this channel (Signal number, mobile, Slack member id). */
  principalHasIdentity: (channel: 'signal' | 'sms' | 'slack') => Promise<boolean>;
  /** Null when the phone app can be installed and push works; otherwise the reason it cannot. */
  phoneAppBlocker: () => string | null;
  /** SIGNAL_VOICE_CALLS_ENABLED: read at boot, set in the deployment, not the console. */
  signalVoiceCallsEnabled: boolean;
  /** Vault first, then the upper-cased env var, as tools resolve secrets. */
  secretPresent: (name: string) => Promise<boolean>;
  browserReady: () => boolean;
  logger: Logger;
}

export interface SetupChecklistTask {
  id: string;
  label: string;
  value_prop: string;
  tier: string;
  handoff: 'in-chat' | 'console';
  handoff_path?: string;
  optional: boolean;
  status: 'done' | 'pending';
  /** One line for the step's form: what is missing or what is being waited on. */
  detail?: string;
  /** Saved, but takes effect only after a restart. */
  restart_required?: true;
  /** vault_secrets_all tasks: the keys, and that done means saved, not running (#2409). */
  vault_keys?: string[];
  done_means?: 'credentials_saved';
  optional_upgrade?: { vault_keys: string[]; configured: boolean; value_prop: string; credential_how_to: string };
  credential_how_to: string | null;
  docs_url: string | null;
}

export interface SetupChecklist {
  tasks: SetupChecklistTask[];
  /** Every required task is done. Unlocks Start onboarding; does not start it. */
  setupComplete: boolean;
  /** Ids of required tasks not yet done, in catalog order. */
  missing: string[];
}

interface CheckResult {
  done: boolean;
  detail?: string;
  restartRequired?: boolean;
}

const ROUTE_LABEL: Record<MessagingRoute, string> = {
  app: 'the Curia app',
  signal: 'Signal',
  sms: 'text message',
  slack: 'Slack',
};

/** Run one check. A failing dependency reads as pending with a logged warning, never throws. */
async function guarded(deps: SetupCheckDeps, id: string, fn: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await fn();
  } catch (err) {
    deps.logger.warn({ errName: err instanceof Error ? err.name : typeof err, err, taskId: id }, 'setup checklist: check failed — reporting pending');
    return { done: false, detail: 'Could not check this right now. Try again in a moment.' };
  }
}

function channelResult(status: ChannelRunStatus, what: string): CheckResult | null {
  if (status === 'running') return null;
  if (status === 'restart_required') return { done: false, restartRequired: true, detail: `${what} is saved and starts after the restart.` };
  return { done: false, detail: `${what} isn't set up yet.` };
}

async function checkMessaging(deps: SetupCheckDeps, route: MessagingRoute | null): Promise<CheckResult> {
  if (!route) return { done: false, detail: 'Choose how Curia will message the principal.' };
  if (route === 'app') {
    const blocker = deps.phoneAppBlocker();
    return blocker ? { done: false, detail: blocker } : { done: true };
  }
  const channel = await deps.channelStatus(route);
  const notRunning = channelResult(channel, ROUTE_LABEL[route]);
  if (!(await deps.principalHasIdentity(route))) {
    const what = route === 'slack' ? "the principal's Slack member ID" : route === 'sms' ? "the principal's mobile number" : "the principal's Signal number";
    return { done: false, restartRequired: notRunning?.restartRequired, detail: `Add ${what}.` };
  }
  return notRunning ?? { done: true };
}

async function checkVoice(deps: SetupCheckDeps, route: VoiceRoute | null): Promise<CheckResult> {
  if (!route) return { done: false, detail: 'Choose how the principal will talk to Curia.' };
  const voice = channelResult(await deps.channelStatus('voice'), 'Voice');
  if (route === 'app') return voice ?? { done: true };
  // Signal calls run on the voice runtime too, so both channels must be up (#1672).
  if (!deps.signalVoiceCallsEnabled) {
    return { done: false, detail: 'Signal calls are turned off on this server (SIGNAL_VOICE_CALLS_ENABLED).' };
  }
  if (voice) return voice;
  const signal = channelResult(await deps.channelStatus('signal'), 'Signal');
  if (signal) return signal;
  return (await deps.principalHasIdentity('signal'))
    ? { done: true }
    : { done: false, detail: "Add the principal's Signal number." };
}

/** Evaluate every catalog task. Never throws for a single failing check. */
export async function evaluateChecklist(catalog: CatalogTask[], deps: SetupCheckDeps): Promise<SetupChecklist> {
  // Read once: every route-dependent check uses the same snapshot.
  const state = await deps.state();

  const results = await Promise.all(catalog.map((task) => guarded(deps, task.id, async (): Promise<CheckResult> => {
    const check = task.completion_check;
    switch (check.type) {
      case 'principal_basics': {
        if (!state.setupFor) return { done: false, detail: 'Choose who Curia is for.' };
        if (state.setupFor === 'other' && (!state.operatorName || !state.operatorEmail)) {
          return { done: false, detail: 'Add your name and email as the operator.' };
        }
        const p = await deps.principal();
        if (!p || !p.displayName.trim()) return { done: false, detail: "Add the principal's name." };
        if (!p.primaryEmail) return { done: false, detail: "Add the principal's email." };
        if (!p.timezone) return { done: false, detail: "Add the principal's timezone." };
        return { done: true };
      }
      case 'office_identity_configured':
        return (await deps.identityConfigured()) ? { done: true } : { done: false, detail: "Save Curia's name." };
      case 'email_channel_ready': {
        const status = await deps.emailChannelStatus();
        if (status === 'running') return { done: true };
        return status === 'restart_required'
          ? { done: false, restartRequired: true, detail: "Curia's mailbox is saved and starts after the restart." }
          : { done: false, detail: "Add the Nylas key and connect Curia's mailbox." };
      }
      case 'messaging_route_ready':
        return checkMessaging(deps, state.messagingRoute);
      case 'voice_route_ready':
        return checkVoice(deps, state.voiceRoute);
      case 'nylas_signin_ready': {
        const r = await deps.nylasSignInReadiness();
        if (r.ready) return { done: true };
        return { done: false, restartRequired: r.reason === 'restart_required', detail: r.detail };
      }
      case 'principal_mailbox_ready':
        return { done: (await deps.principalMailboxReady()) === 'ready' };
      case 'browser_ready':
        return { done: deps.browserReady() };
      case 'vault_secrets_all': {
        const present = await Promise.all(check.keys.map((k) => deps.secretPresent(k)));
        return { done: present.every(Boolean) };
      }
      case 'always_available':
        return { done: true };
    }
  })));

  const tasks = await Promise.all(catalog.map(async (task, i): Promise<SetupChecklistTask> => {
    const r = results[i]!;
    const { completion_check: check, optional_upgrade: upgrade, optional, ...rest } = task;
    const out: SetupChecklistTask = {
      ...rest,
      optional: optional === true,
      status: r.done ? 'done' : 'pending',
      ...(r.detail && !r.done ? { detail: r.detail } : {}),
      ...(r.restartRequired ? { restart_required: true as const } : {}),
      ...(check.type === 'vault_secrets_all' ? { vault_keys: check.keys, done_means: 'credentials_saved' as const } : {}),
    };
    if (upgrade) {
      let configured = false;
      try {
        configured = (await Promise.all(upgrade.keys.map((k) => deps.secretPresent(k)))).every(Boolean);
      } catch (err) {
        deps.logger.warn({ err, taskId: task.id }, 'setup checklist: optional upgrade check failed — reporting not configured');
      }
      out.optional_upgrade = { vault_keys: upgrade.keys, configured, value_prop: upgrade.value_prop, credential_how_to: upgrade.credential_how_to };
    }
    return out;
  }));

  const missing = tasks.filter((t) => !t.optional && t.status !== 'done').map((t) => t.id);
  return { tasks, setupComplete: missing.length === 0, missing };
}
