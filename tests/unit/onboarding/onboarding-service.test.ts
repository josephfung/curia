import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import pino from 'pino';
import { OnboardingService, type OnboardingServiceDeps } from '../../../src/onboarding/onboarding-service.js';
import type { TaskRow } from '../../../src/db/queries/tasks.js';
import type { CreateTaskParams } from '../../../src/db/task-repo.js';
import type { RegistryEntry, RegistryKind } from '../../../src/registry/types.js';
import type { WorkingDocsRepo } from '../../../src/db/working-docs-repo.js';
import type { MessagingRoute } from '../../../src/setup/setup-state.js';
import { isTriageHeld } from '../../../src/onboarding/triage-hold.js';
import { readOnboardingState } from '../../../src/onboarding/state.js';

const logger = pino({ level: 'silent' });

// Synthetic playbook: three first-conversation topics, plus a duplicate id that is skipped.
const PLAYBOOK = [
  '# First conversation <!-- session: first-conversation -->',
  '## Hello <!-- topic: hello -->',
  'Say hello.',
  '## How I should sound <!-- topic: style -->',
  'Tone.',
  '## Again <!-- topic: style -->',
  'Duplicate id.',
  '## Next step <!-- topic: next-step -->',
  'Book the next session.',
  '# Review <!-- session: review -->',
  '## Walk through the drafts <!-- topic: walk-drafts -->',
  'Drafts.',
].join('\n');
const FIRST_CONVERSATION_TOPICS = 3;

type SetupRow = { phase: string | null; completed_at: Date | null; messaging_route: MessagingRoute | null; setup_for: string | null };

function makeHarness(opts: {
  setup?: Partial<SetupRow>;
  enabled?: Partial<Record<RegistryKind, string[]>>;
  priorCeoTasks?: boolean;
  hasIdentity?: boolean;
  appOrigin?: string;
} = {}) {
  const setup: SetupRow = {
    phase: 'complete',
    completed_at: new Date('2026-11-20T12:00:00Z'),
    messaging_route: 'app',
    setup_for: 'other',
    ...opts.setup,
  };
  const txQueries: string[] = [];
  const pool = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM setup_state')) {
        return { rows: [{ ...setup, operator_name: null, operator_email: null, voice_route: null }] };
      }
      if (sql.includes('FROM tasks')) return { rows: [{ exists: opts.priorCeoTasks ?? false }] };
      throw new Error(`unexpected pool query: ${sql}`);
    }),
    connect: vi.fn(async () => ({
      query: vi.fn(async (sql: string) => {
        txQueries.push(sql);
        return { rows: [] };
      }),
      release: vi.fn(),
    })),
  };

  const tasks: TaskRow[] = [];
  let nextId = 1;
  const taskRepo = {
    createTask: vi.fn(async (p: CreateTaskParams) => {
      const row = {
        id: `task-${nextId++}`,
        agentId: p.agentId,
        title: p.title,
        status: 'open',
        tags: p.tags ?? [],
        parentTaskId: p.parentTaskId ?? null,
        createdBy: p.createdBy ?? p.agentId,
        source: p.source,
      } as unknown as TaskRow;
      tasks.push(row);
      return row;
    }),
    listTasks: vi.fn(async (f: { tag?: string; statuses?: string[] }) =>
      tasks.filter((t) => (!f.tag || t.tags.includes(f.tag)) && (!f.statuses || f.statuses.includes(t.status))),
    ),
    setActiveSkillsBlock: vi.fn(async () => ({ task: tasks[0]!, block: { skills: [] } })),
    updateTask: vi.fn(async () => null),
  };

  const enabled = new Map<RegistryKind, Set<string>>(
    (['agent', 'skill', 'tool'] as RegistryKind[]).map((k) => [k, new Set(opts.enabled?.[k] ?? [])]),
  );
  const registry = {
    list: vi.fn(async (kind: RegistryKind) =>
      [...enabled.get(kind)!].map((name) => ({ name, kind, state: 'enabled' }) as RegistryEntry),
    ),
    installAndEnable: vi.fn(async (kind: RegistryKind, name: string) => {
      enabled.get(kind)!.add(name);
      return { name, kind, state: 'enabled' } as RegistryEntry;
    }),
  };

  const scheduler = { enqueueTaskWake: vi.fn(async () => ({ jobId: 'job' })) };
  const store = new Map<string, string>();
  const configStore = {
    get: vi.fn(async (ns: string, key: string) => store.get(`${ns}/${key}`) ?? null),
    set: vi.fn(async (ns: string, key: string, value: string) => {
      store.set(`${ns}/${key}`, value);
      return { stored: true, action: 'set' };
    }),
  };
  const workingDocsRepo = {
    read: vi.fn(async () => ({ body: PLAYBOOK })),
    create: vi.fn(),
  } as unknown as WorkingDocsRepo;
  const mintInvitation = vi.fn(async () => ({ pairUrl: 'https://curia.example.com/pair#c=tok', expiresAt: '2026-11-22T12:00:00.000Z' }));
  const scheduleProcessExit = vi.fn();

  const deps: OnboardingServiceDeps = {
    pool: pool as unknown as Pool,
    taskRepo: taskRepo as unknown as OnboardingServiceDeps['taskRepo'],
    registry,
    scheduler,
    configStore,
    workingDocsRepo,
    principalName: async () => 'Avery Example',
    principalHasIdentity: async () => opts.hasIdentity ?? true,
    appOrigin: 'appOrigin' in opts ? opts.appOrigin : 'https://curia.example.com',
    mintInvitation,
    scheduleProcessExit,
    logger,
  };
  return { service: new OnboardingService(deps), tasks, taskRepo, registry, scheduler, configStore, mintInvitation, scheduleProcessExit, txQueries };
}

describe('OnboardingService.start', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses while Setup is not complete', async () => {
    const h = makeHarness({ setup: { phase: 'in_progress' } });
    expect(await h.service.start({ actor: 'operator' })).toEqual({ ok: false, code: 'setup_incomplete' });
    expect(h.taskRepo.createTask).not.toHaveBeenCalled();
  });

  it('creates the parent, one subtask per first-conversation topic and the homework, then refuses a second start', async () => {
    const h = makeHarness();
    const result = await h.service.start({ actor: 'operator' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parent = h.tasks.find((t) => !t.parentTaskId)!;
    expect(result.taskId).toBe(parent.id);
    expect(parent.createdBy).toBe('onboarding');
    expect(parent.tags).toEqual(['onboarding']);
    const children = h.tasks.filter((t) => t.parentTaskId === parent.id);
    const homework = children.filter((t) => t.tags.includes('onboarding:homework'));
    const topics = children.filter((t) => t.tags.some((tag) => tag.startsWith('onboarding:topic:')));
    expect(homework).toHaveLength(1);
    expect(topics).toHaveLength(FIRST_CONVERSATION_TOPICS);
    expect(topics.map((t) => t.tags)).toContainEqual(['onboarding', 'onboarding:topic:style', 'onboarding:session:first-conversation']);
    expect(h.tasks.every((t) => t.createdBy === 'onboarding')).toBe(true);
    expect(h.tasks).toHaveLength(1 + FIRST_CONVERSATION_TOPICS + 1);

    // Triage held, the four registry entries enabled, the onboarding skill active.
    expect(await isTriageHeld(h.configStore)).toBe(true);
    expect(h.registry.installAndEnable.mock.calls.map(([k, n]) => `${k}:${n}`).sort()).toEqual(
      ['agent:ceo-inbox', 'skill:ceo-inbox', 'skill:learning', 'skill:tasks'],
    );
    const activeFor = h.taskRepo.setActiveSkillsBlock.mock.calls.map((c) => (c as unknown[])[0] as string);
    expect(activeFor).toEqual(expect.arrayContaining([parent.id, homework[0]!.id]));
    expect(h.taskRepo.setActiveSkillsBlock.mock.calls.every((c) => {
      const block = (c as unknown[])[1] as { skills: Array<{ name: string }> };
      return block.skills.map((s) => s.name).join() === 'onboarding';
    })).toBe(true);
    expect(result.restartScheduled).toBe(true);
    expect(h.scheduleProcessExit).toHaveBeenCalledTimes(1);

    // The thread rotated under the advisory lock.
    expect(h.txQueries.some((q) => q.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(h.txQueries.some((q) => q.includes('web_thread'))).toBe(true);
    expect((await readOnboardingState(h.configStore))?.taskId).toBe(parent.id);

    const again = await h.service.start({ actor: 'operator' });
    expect(again).toEqual({ ok: false, code: 'already_started' });
    expect(h.tasks).toHaveLength(1 + FIRST_CONVERSATION_TOPICS + 1);
  });

  it('asks to confirm a working principal, then starts once confirmed', async () => {
    const h = makeHarness({ enabled: { agent: ['ceo-inbox'] }, priorCeoTasks: true });
    const refused = await h.service.start({ actor: 'operator' });
    expect(refused).toMatchObject({ ok: false, code: 'confirm_working_principal' });
    if (refused.ok) return;
    expect(refused.signals).toHaveLength(2);
    expect(h.taskRepo.createTask).not.toHaveBeenCalled();

    const ok = await h.service.start({ actor: 'operator', confirmWorkingPrincipal: true });
    expect(ok.ok).toBe(true);
  });

  it('app route: returns the invitation and wakes only the homework', async () => {
    const h = makeHarness({ enabled: { agent: ['ceo-inbox'], skill: ['ceo-inbox', 'learning', 'tasks'] } });
    const result = await h.service.start({ actor: 'operator', confirmWorkingPrincipal: true });
    if (!result.ok) throw new Error('expected ok');
    expect(result.invitation).toEqual({ url: 'https://curia.example.com/pair#c=tok', expiresAt: '2026-11-22T12:00:00.000Z' });
    expect(result.restartScheduled).toBe(false);
    expect(h.scheduleProcessExit).not.toHaveBeenCalled();
    const homework = h.tasks.find((t) => t.tags.includes('onboarding:homework'))!;
    expect(h.scheduler.enqueueTaskWake.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      expect.objectContaining({ taskId: homework.id }),
    ]);
  });

  it('signal route: wakes the parent to send the greeting, no invitation', async () => {
    const h = makeHarness({ setup: { messaging_route: 'signal' } });
    const result = await h.service.start({ actor: 'operator' });
    if (!result.ok) throw new Error('expected ok');
    expect(result.invitation).toBeNull();
    expect(h.mintInvitation).not.toHaveBeenCalled();
    const woken = h.scheduler.enqueueTaskWake.mock.calls.map((c) => ((c as unknown[])[0] as { taskId: string }).taskId);
    expect(woken).toContain(result.taskId);
    const parentCall = h.taskRepo.createTask.mock.calls.find(([p]) => !p.parentTaskId)!;
    expect(parentCall[0].progressNote).toBe('Send the greeting');
  });

  it('refuses before creating anything when the principal has no verified id on the route', async () => {
    const h = makeHarness({ setup: { messaging_route: 'sms' }, hasIdentity: false });
    expect(await h.service.start({ actor: 'operator' })).toEqual({ ok: false, code: 'route_unreachable' });
    expect(h.taskRepo.createTask).not.toHaveBeenCalled();
    expect(await isTriageHeld(h.configStore)).toBe(false);
  });
});

describe('OnboardingService.status', () => {
  it('shows no dashboard alert on an install whose Setup never completed on the page', async () => {
    const h = makeHarness({ setup: { completed_at: null } });
    const status = await h.service.status();
    expect(status).toMatchObject({ started: false, showDashboardAlert: false, principalName: 'Avery Example' });
  });

  it('shows the alert after Setup completed and before onboarding starts', async () => {
    const h = makeHarness();
    expect((await h.service.status()).showDashboardAlert).toBe(true);
    await h.service.start({ actor: 'operator' });
    expect(await h.service.status()).toMatchObject({ started: true, showDashboardAlert: false });
  });
});
