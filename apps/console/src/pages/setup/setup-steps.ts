// The Setup page's steps and the rules around them (#2358). Pure: no React, no fetch, so
// the step marks, the first-load gate and the first-name fallback are unit-tested.

/** One task from GET /api/setup/checklist (src/setup/checklist.ts SetupChecklistTask). */
export interface ChecklistTask {
  id: string;
  label: string;
  optional: boolean;
  status: 'done' | 'pending';
  detail?: string;
  restart_required?: true;
  handoff_path?: string;
  credential_how_to: string | null;
  docs_url: string | null;
  /** An optional key that raises a limit (web_research's Tavily key). */
  optional_upgrade?: { vault_keys: string[]; configured: boolean };
}

export interface Checklist {
  setupFor: 'self' | 'other' | null;
  tasks: ChecklistTask[];
  setupComplete: boolean;
  missing: string[];
}

export type StepId =
  | 'who' | 'curia_name' | 'email' | 'messaging' | 'voice' | 'mailbox_signin' | 'google_workspace'
  | 'apply' | 'start'
  | ExtraId;

/** The optional extras: listed after Start onboarding, never numbered, never required. */
export type ExtraId = 'working_style' | 'web_research' | 'capabilities';

export type StepGroup = 'basics' | 'channels' | 'accounts' | 'finish' | 'extras';

export interface StepDef {
  id: StepId;
  group: StepGroup;
  name: string;
}

/** In order. A catalog task's id doubles as its step's id. */
export const STEPS: readonly StepDef[] = [
  { id: 'who', group: 'basics', name: 'Who it’s for' },
  { id: 'curia_name', group: 'basics', name: 'Curia’s name' },
  { id: 'email', group: 'channels', name: 'Email' },
  { id: 'messaging', group: 'channels', name: 'Messaging' },
  { id: 'voice', group: 'channels', name: 'Voice' },
  { id: 'mailbox_signin', group: 'accounts', name: 'Email & calendar' },
  // Required since #2683: the onboarding deep dive delivers its drafts as Google Docs.
  { id: 'google_workspace', group: 'accounts', name: 'Google Workspace' },
  { id: 'apply', group: 'finish', name: 'Apply & restart' },
  { id: 'start', group: 'finish', name: 'Start onboarding' },
];

/** In order, after the steps. A catalog task's id doubles as the extra's id. */
export const EXTRAS: readonly StepDef[] = [
  { id: 'working_style', group: 'extras', name: 'Working style' },
  { id: 'web_research', group: 'extras', name: 'Higher search limit' },
  { id: 'capabilities', group: 'extras', name: 'Capabilities' },
];

const STEP_IDS: ReadonlySet<string> = new Set([...STEPS, ...EXTRAS].map((s) => s.id));
const EXTRA_IDS: ReadonlySet<string> = new Set(EXTRAS.map((s) => s.id));

export function isExtra(step: StepId): step is ExtraId {
  return EXTRA_IDS.has(step);
}

export function isStepId(value: unknown): value is StepId {
  return typeof value === 'string' && STEP_IDS.has(value);
}

/**
 * The group heading. The accounts group is Business Apps: the principal's email and calendar,
 * Curia's Google Workspace, and later other business applications Curia is authorized for.
 */
export function groupLabel(group: StepGroup): string {
  switch (group) {
    case 'basics': return 'Basics';
    case 'channels': return 'Curia’s channels';
    case 'accounts': return 'Business Apps';
    case 'finish': return 'Finish';
    case 'extras': return 'Optional extras';
  }
}

export type StepMark = 'done' | 'attention' | 'todo' | 'locked';

/**
 * The mark beside a step in the list. Steps that are catalog tasks read their task.
 * Apply & restart needs attention while anything is saved but waiting for a restart.
 * Start onboarding is locked until every required step is done.
 */
export function stepMark(step: StepId, checklist: Checklist | null): StepMark {
  if (!checklist) return step === 'start' ? 'locked' : 'todo';
  if (isExtra(step)) return extraMark(step, checklist);
  if (step === 'start') return checklist.setupComplete ? 'todo' : 'locked';
  if (step === 'apply') {
    if (checklist.tasks.some((t) => !t.optional && t.restart_required)) return 'attention';
    return checklist.setupComplete ? 'done' : 'todo';
  }
  const task = checklist.tasks.find((t) => t.id === step);
  if (!task) return 'todo';
  if (task.status === 'done') return 'done';
  return task.restart_required ? 'attention' : 'todo';
}

/**
 * An extra is ticked only once it has something set up: the Tavily key. Working style and Capabilities are never ticked: their checks are always done
 * (the defaults are fine), so a tick would say nothing about whether the operator chose
 * anything.
 */
function extraMark(step: ExtraId, checklist: Checklist): StepMark {
  const task = checklist.tasks.find((t) => t.id === step);
  switch (step) {
    case 'working_style':
    case 'capabilities':
      return 'todo';
    case 'web_research': return task?.optional_upgrade?.configured ? 'done' : 'todo';
  }
}

/**
 * Where a returning operator lands: the first required step that is not done (a step
 * waiting for a restart is not done, so it is that step, whose line points to Apply &
 * restart), or Start onboarding once all are.
 */
export function firstOpenStep(checklist: Checklist | null): StepId {
  if (!checklist) return 'who';
  const open = STEPS.find((s) => s.id !== 'apply' && s.id !== 'start' && stepMark(s.id, checklist) !== 'done');
  return open ? open.id : 'start';
}

/**
 * The step after this one, for Save and continue. Null after Start onboarding, which has no
 * such button. The extras run in order, and the last goes back to Start onboarding.
 */
export function nextStep(step: StepId): StepId | null {
  if (isExtra(step)) {
    const i = EXTRAS.findIndex((s) => s.id === step);
    return EXTRAS[i + 1]?.id ?? 'start';
  }
  const i = STEPS.findIndex((s) => s.id === step);
  return STEPS[i + 1]?.id ?? null;
}

/** "Dana" from "Dana Okafor"; null for an empty name. */
export function firstName(fullName: string | null | undefined): string | null {
  const first = (fullName ?? '').trim().split(/\s+/)[0];
  return first ? first : null;
}

/** How later steps refer to the principal before and after their name is saved. */
export function principalLabel(fullName: string | null | undefined): string {
  return firstName(fullName) ?? 'your principal';
}

/** The same label at the start of a sentence: "Your principal", or the name unchanged. */
export function atSentenceStart(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Steps the Start onboarding note lists as left to do, in order. */
export function stepsLeft(checklist: Checklist | null): StepDef[] {
  if (!checklist) return STEPS.filter((s) => s.id !== 'apply' && s.id !== 'start');
  const missing = new Set(checklist.missing);
  return STEPS.filter((s) => missing.has(s.id));
}

// ── First-load gate (router.tsx) ─────────────────────────────────────────────

/**
 * Pages an operator may open while Setup runs: the Setup page itself, and the Settings
 * pages a channel step links to until it has its own form. Everything else (the home page,
 * chat, the knowledge graph) waits until Start onboarding.
 */
const OPEN_DURING_SETUP = [
  '/setup', '/settings', '/system', '/channels', '/tools', '/agents', '/mcp-skills', '/secrets',
  '/contacts',
];

function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Where the console should send a signed-in operator, or null to stay. `inSetup` comes
 * from GET /api/identity. Unknown (the call failed, was rate-limited, or the server is
 * restarting) means stay put: a failed check must never move an operator into or out of
 * Setup mid-step.
 */
export function setupRedirect(pathname: string, session: { inSetup: boolean | null }): '/setup' | '/' | null {
  if (session.inSetup === null) return null;
  if (session.inSetup) return OPEN_DURING_SETUP.some((p) => underPrefix(pathname, p)) ? null : '/setup';
  return underPrefix(pathname, '/setup') ? '/' : null;
}

// ── Route saves ──────────────────────────────────────────────────────────────

/**
 * Runs saves one at a time, latest choice wins. A choice made while a save is in flight
 * waits; if several arrive, only the newest is saved next. So two quick picks can never
 * land out of order and leave an older route stored (#2358, CodeRabbit on #2688).
 * A failed save drops anything queued behind it: the caller shows the error and the
 * stored value is re-read.
 */
export function createLatestSaver<T>(save: (value: T) => Promise<void>): (value: T) => Promise<void> {
  let running: Promise<void> | null = null;
  let queued: { value: T } | null = null;
  return async (value: T): Promise<void> => {
    queued = { value };
    if (running) return running;
    running = (async () => {
      try {
        while (queued) {
          const next: T = queued.value;
          queued = null;
          await save(next);
        }
      } finally {
        queued = null;
        running = null;
      }
    })();
    return running;
  };
}

interface SharedSaver<T> {
  /** The newest mount's save; the queue calls it when a value's turn comes. */
  save: (value: T) => Promise<void>;
  run: (value: T) => Promise<void>;
}
const sharedSavers = new Map<string, SharedSaver<never>>();

/**
 * createLatestSaver for one stored value, shared by every mount of the step that saves it. A
 * step remounts when the operator opens another step and comes back; a queue of its own would
 * let a pick made after coming back save while the one before is still running, and the slow
 * older save land last (CodeRabbit on #2688). Each call makes `save` the one the queue uses.
 */
export function sharedLatestSaver<T>(key: string, save: (value: T) => Promise<void>): (value: T) => Promise<void> {
  let entry = sharedSavers.get(key) as SharedSaver<T> | undefined;
  if (!entry) {
    const fresh: SharedSaver<T> = { save, run: async () => {} };
    fresh.run = createLatestSaver((value: T) => fresh.save(value));
    sharedSavers.set(key, fresh as unknown as SharedSaver<never>);
    entry = fresh;
  }
  entry.save = save;
  return entry.run;
}
