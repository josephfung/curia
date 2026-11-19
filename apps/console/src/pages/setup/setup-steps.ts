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
}

export interface Checklist {
  setupFor: 'self' | 'other' | null;
  tasks: ChecklistTask[];
  setupComplete: boolean;
  missing: string[];
}

export type StepId =
  | 'who' | 'curia_name' | 'email' | 'messaging' | 'voice' | 'mailbox_signin'
  | 'apply' | 'start';

export type StepGroup = 'basics' | 'channels' | 'accounts' | 'finish';

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
  { id: 'apply', group: 'finish', name: 'Apply & restart' },
  { id: 'start', group: 'finish', name: 'Start onboarding' },
];

const STEP_IDS: ReadonlySet<string> = new Set(STEPS.map((s) => s.id));

export function isStepId(value: unknown): value is StepId {
  return typeof value === 'string' && STEP_IDS.has(value);
}

/** The group heading. The accounts group is named after the principal once known. */
export function groupLabel(group: StepGroup, principalFirstName: string | null): string {
  switch (group) {
    case 'basics': return 'Basics';
    case 'channels': return 'Curia’s channels';
    case 'accounts': return principalFirstName ? `${principalFirstName}’s accounts` : 'Your principal’s accounts';
    case 'finish': return 'Finish';
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
 * Where a returning operator lands: the first required step that is not done (a step
 * waiting for a restart is not done, so it is that step, whose line points to Apply &
 * restart), or Start onboarding once all are.
 */
export function firstOpenStep(checklist: Checklist | null): StepId {
  if (!checklist) return 'who';
  const open = STEPS.find((s) => s.id !== 'apply' && s.id !== 'start' && stepMark(s.id, checklist) !== 'done');
  return open ? open.id : 'start';
}

/** The step after this one, for Save and continue. Null after the last. */
export function nextStep(step: StepId): StepId | null {
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
