import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import pino from 'pino';
import { OnboardingService, RESTART_RESUME_NOTE, type OnboardingServiceDeps } from '../../../src/onboarding/onboarding-service.js';
import type { TaskRow } from '../../../src/db/queries/tasks.js';
import type { CreateTaskParams } from '../../../src/db/task-repo.js';
import type { RegistryEntry, RegistryKind } from '../../../src/registry/types.js';
import type { WorkingDocsRepo } from '../../../src/db/working-docs-repo.js';
import type { MessagingRoute, VoiceRoute } from '../../../src/settings/registry.js';
import { isTriageHeld } from '../../../src/onboarding/triage-hold.js';
import { readOnboardingState } from '../../../src/onboarding/state.js';

const logger = pino({ level: 'silent' });
const PRINCIPAL_CONTACT_ID = '00000000-0000-4000-8000-0000000000a1';

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
/** Everything Start enables already on: no restart. */
const ALL_REQUIRED_ENABLED = { agent: ['ceo-inbox'], skill: ['ceo-inbox', 'learning', 'tasks'] };

// What the settings store holds for Setup: the operator's presence is setup_for, and a
// completed_at is the phase (#2709).
type SetupRow = {
  completed_at: string | null;
  /** False when migration 132 marked Setup complete rather than the Setup page. Defaults true. */
  completed_on_page: boolean;
  messaging_route: MessagingRoute | null;
  voice_route: VoiceRoute | null;
};

function makeHarness(opts: {
  setup?: Partial<SetupRow>;
  enabled?: Partial<Record<RegistryKind, string[]>>;
  priorCeoTasks?: boolean;
  hasIdentity?: boolean;
  appOrigin?: string;
  /** What this process loaded at boot; defaults to what is enabled when the harness is built. */
  loaded?: Partial<Record<RegistryKind, string[]>>;
  /** Make a transaction statement fail (COMMIT, the lock). */
  txFail?: (sql: string) => Error | undefined;
  persistentStore?: boolean;
  /** Whether a principal mailbox is connected (for the deep dive). Defaults false. */
  hasMailbox?: boolean | 'unwired';
} = {}) {
  const setup: SetupRow = {
    completed_at: '2026-11-20T12:00:00.000Z',
    completed_on_page: true,
    messaging_route: 'app',
    voice_route: null,
    ...opts.setup,
  };
  const settingsRows = [
    { key: 'operator', value: { name: 'Operator', email: 'operator@example.com' }, updated_by: 'console' },
    ...(setup.messaging_route ? [{ key: 'messaging_route', value: setup.messaging_route, updated_by: 'console' }] : []),
    ...(setup.voice_route ? [{ key: 'voice_route', value: setup.voice_route, updated_by: 'console' }] : []),
    ...(setup.completed_at
      ? [{ key: 'setup.completed_at', value: setup.completed_at, updated_by: setup.completed_on_page ? 'console' : 'migration:132:pre-setup-page' }]
      : []),
  ];
  const txQueries: string[] = [];
  const taskQueryParams: unknown[][] = [];
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM settings')) return { rows: settingsRows };
      if (sql.includes('FROM tasks')) {
        taskQueryParams.push(params ?? []);
        return { rows: [{ exists: opts.priorCeoTasks ?? false }] };
      }
      throw new Error(`unexpected pool query: ${sql}`);
    }),
    connect: vi.fn(async () => ({
      query: vi.fn(async (sql: string) => {
        txQueries.push(sql);
        const fail = opts.txFail?.(sql);
        if (fail) throw fail;
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
        status: p.status ?? 'open',
        waitingOnContactId: p.waitingOnContactId ?? null,
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
    getTask: vi.fn(async (id: string) => tasks.find((t) => t.id === id) ?? null),
    setActiveSkillsBlock: vi.fn(async () => ({ task: tasks[0]!, block: { skills: [] } })),
    updateTask: vi.fn(async (id: string, u: { status?: string }) => {
      const row = tasks.find((t) => t.id === id);
      if (row && u.status) (row as { status: string }).status = u.status;
      return row ?? null;
    }),
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

  const loaded = opts.loaded ?? opts.enabled ?? {};
  const loadedAtBoot = (kind: RegistryKind, name: string) => (loaded[kind] ?? []).includes(name);

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
    read: vi.fn(async () => ({ body: PLAYBOOK, frontmatter: { editable_by: 'console' } })),
    create: vi.fn(),
  } as unknown as WorkingDocsRepo;
  const mintInvitation = vi.fn(async () => ({ id: 'inv-1', pairUrl: 'https://curia.example.com/pair#c=tok', expiresAt: '2026-11-22T12:00:00.000Z' }));
  const stopInvitation = vi.fn(async () => true);
  const scheduleProcessExit = vi.fn();
  const startOnce = vi.fn(async () => ({ started: true as const }));

  const deps: OnboardingServiceDeps = {
    pool: pool as unknown as Pool,
    taskRepo: taskRepo as unknown as OnboardingServiceDeps['taskRepo'],
    registry,
    scheduler,
    configStore,
    stateLock: (fn) => fn(),
    workingDocsRepo,
    principalName: async () => 'Avery Example',
    principalContactId: async () => PRINCIPAL_CONTACT_ID,
    principalHasIdentity: async () => opts.hasIdentity ?? true,
    appOrigin: 'appOrigin' in opts ? opts.appOrigin : 'https://curia.example.com',
    mintInvitation,
    stopInvitation,
    scheduleProcessExit,
    loadedAtBoot,
    persistentStore: opts.persistentStore ?? true,
    logger,
    ...(opts.hasMailbox === 'unwired' ? {} : { hasPrincipalMailbox: async () => opts.hasMailbox === true }),
    deepDive: { startOnce },
  };
  return { service: new OnboardingService(deps), startOnce, tasks, taskRepo, registry, scheduler, configStore, mintInvitation, stopInvitation, scheduleProcessExit, txQueries, taskQueryParams };
}

describe('OnboardingService.start', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses while Setup is not complete', async () => {
    const h = makeHarness({ setup: { completed_at: null } });
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
    // The parent and topics wait on the principal (not heartbeat candidates); the homework has its own wake.
    for (const t of [parent, ...topics]) {
      expect(t).toMatchObject({ status: 'waiting', waitingOnContactId: PRINCIPAL_CONTACT_ID });
    }
    expect(homework[0]).toMatchObject({ status: 'open', waitingOnContactId: null });

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

  it('start starts the deep dive when a mailbox already exists', async () => {
    const h = makeHarness({ enabled: ALL_REQUIRED_ENABLED, hasMailbox: true });
    const result = await h.service.start({ actor: 'operator', confirmWorkingPrincipal: true });
    expect(result.ok).toBe(true);
    expect(h.startOnce).toHaveBeenCalledTimes(1);
  });

  it('start does not when none', async () => {
    const h = makeHarness({ enabled: ALL_REQUIRED_ENABLED, hasMailbox: false });
    const result = await h.service.start({ actor: 'operator', confirmWorkingPrincipal: true });
    expect(result.ok).toBe(true);
    expect(h.startOnce).not.toHaveBeenCalled();
  });

  it('a deep-dive start that throws does not fail onboarding start', async () => {
    const h = makeHarness({ enabled: ALL_REQUIRED_ENABLED, hasMailbox: true });
    h.startOnce.mockRejectedValueOnce(new Error('store down'));
    const result = await h.service.start({ actor: 'operator', confirmWorkingPrincipal: true });
    expect(result.ok).toBe(true);
    expect(h.startOnce).toHaveBeenCalledTimes(1);
  });

  it('without a mailbox check, start leaves the decision to startOnce', async () => {
    const h = makeHarness({ enabled: ALL_REQUIRED_ENABLED, hasMailbox: 'unwired' });
    expect((await h.service.start({ actor: 'operator', confirmWorkingPrincipal: true })).ok).toBe(true);
    expect(h.startOnce).toHaveBeenCalledTimes(1);
  });

  it('a refused start starts no deep dive', async () => {
    const h = makeHarness({ setup: { completed_at: null }, hasMailbox: true });
    expect((await h.service.start({ actor: 'operator' })).ok).toBe(false);
    expect(h.startOnce).not.toHaveBeenCalled();
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
    expect(result.invitation).toEqual({ id: 'inv-1', url: 'https://curia.example.com/pair#c=tok', expiresAt: '2026-11-22T12:00:00.000Z' });
    expect((await readOnboardingState(h.configStore))?.invitationId).toBe('inv-1');
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

  it('a start that fails after minting stops the invitation, cancels its tasks, restores the hold and records no state', async () => {
    const h = makeHarness({ enabled: ALL_REQUIRED_ENABLED });
    h.scheduler.enqueueTaskWake.mockRejectedValueOnce(new Error('scheduler down'));
    await expect(h.service.start({ actor: 'operator', confirmWorkingPrincipal: true })).rejects.toThrow('scheduler down');
    expect(h.mintInvitation).toHaveBeenCalledTimes(1);
    expect(h.stopInvitation).toHaveBeenCalledWith('inv-1');
    expect(h.taskRepo.updateTask).toHaveBeenCalledTimes(h.tasks.length);
    expect(await isTriageHeld(h.configStore)).toBe(false);
    expect(await readOnboardingState(h.configStore)).toBeNull();
    expect(h.scheduleProcessExit).not.toHaveBeenCalled();
    // The alert comes back: a failed start is not a start.
    expect(await h.service.status()).toMatchObject({ started: false, showDashboardAlert: true });
  });

  it('a failed start keeps an earlier hold, and keeps triage held when it newly enabled Email triage', async () => {
    const prior = makeHarness({ enabled: ALL_REQUIRED_ENABLED });
    await prior.configStore.set('onboarding', 'triage_hold', JSON.stringify({ held: true }));
    prior.scheduler.enqueueTaskWake.mockRejectedValueOnce(new Error('scheduler down'));
    await expect(prior.service.start({ actor: 'operator', confirmWorkingPrincipal: true })).rejects.toThrow('scheduler down');
    expect(await isTriageHeld(prior.configStore)).toBe(true);

    const fresh = makeHarness();
    fresh.scheduler.enqueueTaskWake.mockRejectedValueOnce(new Error('scheduler down'));
    await expect(fresh.service.start({ actor: 'operator', confirmWorkingPrincipal: true })).rejects.toThrow('scheduler down');
    expect(fresh.registry.installAndEnable).toHaveBeenCalledWith('agent', 'ceo-inbox', 'onboarding');
    expect(await isTriageHeld(fresh.configStore)).toBe(true);
  });

  it('a start where a later enable throws still leaves triage held', async () => {
    const h = makeHarness();
    h.registry.installAndEnable.mockImplementation(async (kind: string, name: string) => {
      if (!(kind === 'agent' && name === 'ceo-inbox')) throw new Error('enable failed');
      return { name, kind, state: 'enabled' } as never;
    });
    await expect(h.service.start({ actor: 'operator', confirmWorkingPrincipal: true })).rejects.toThrow('enable failed');
    expect(h.registry.installAndEnable).toHaveBeenCalledWith('agent', 'ceo-inbox', 'onboarding');
    expect(await isTriageHeld(h.configStore)).toBe(true);
  });

  it('keeps triage held when the Email triage enable committed but its read-back threw', async () => {
    const h = makeHarness();
    const enable = h.registry.installAndEnable.getMockImplementation()!;
    h.registry.installAndEnable.mockImplementation(async (kind: RegistryKind, name: string) => {
      const entry = await enable(kind, name);
      // The enable committed; the entry read that follows it fails.
      if (kind === 'agent') throw new Error('read-back failed');
      return entry;
    });
    await expect(h.service.start({ actor: 'operator', confirmWorkingPrincipal: true })).rejects.toThrow('read-back failed');
    expect(await isTriageHeld(h.configStore)).toBe(true);
  });

  it('keeps triage held when a failed Email triage enable leaves its state unreadable', async () => {
    const h = makeHarness();
    h.registry.installAndEnable.mockRejectedValue(new Error('enable failed'));
    const list = h.registry.list.getMockImplementation()!;
    h.registry.list.mockImplementation(async (kind: RegistryKind) => {
      if (h.registry.installAndEnable.mock.calls.length > 0) throw new Error('registry unreadable');
      return list(kind);
    });
    await expect(h.service.start({ actor: 'operator', confirmWorkingPrincipal: true })).rejects.toThrow('enable failed');
    expect(await isTriageHeld(h.configStore)).toBe(true);
  });

  it('restores the hold when a failed Email triage enable left the agent disabled', async () => {
    const h = makeHarness();
    h.registry.installAndEnable.mockRejectedValue(new Error('secrets missing'));
    await expect(h.service.start({ actor: 'operator', confirmWorkingPrincipal: true })).rejects.toThrow('secrets missing');
    expect(await isTriageHeld(h.configStore)).toBe(false);
  });

  it('a failed COMMIT undoes the start: tasks cancelled, invitation stopped, earlier state restored', async () => {
    const h = makeHarness({ enabled: ALL_REQUIRED_ENABLED, txFail: (sql) => (sql === 'COMMIT' ? new Error('commit lost') : undefined) });
    const earlier = { taskId: 'old-task', startedAt: '2026-11-01T00:00:00.000Z', route: 'app', greetingSentAt: null, followUpsSent: 0, lastFollowUpAt: null, lastPrincipalTurnAt: null, idleNudgeSentAt: null, operatorNotified: [] };
    await h.configStore.set('onboarding', 'state', JSON.stringify(earlier));
    await expect(h.service.start({ actor: 'operator', confirmWorkingPrincipal: true })).rejects.toThrow('commit lost');
    expect(h.stopInvitation).toHaveBeenCalledWith('inv-1');
    expect(h.tasks.every((t) => t.status === 'cancelled')).toBe(true);
    expect(await readOnboardingState(h.configStore)).toEqual(earlier);
    expect(await isTriageHeld(h.configStore)).toBe(false);
    expect(h.scheduleProcessExit).not.toHaveBeenCalled();
  });

  it('a retry whose entries an earlier start enabled, but this process never loaded, still restarts', async () => {
    const h = makeHarness({ enabled: ALL_REQUIRED_ENABLED, loaded: {} });
    const result = await h.service.start({ actor: 'operator', confirmWorkingPrincipal: true });
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
    expect(h.registry.installAndEnable).not.toHaveBeenCalled();
    expect(result.restartScheduled).toBe(true);
    expect(h.scheduleProcessExit).toHaveBeenCalledWith(500);
  });

  it('answers start_in_progress when another start holds the lock past its timeout', async () => {
    const lockTimeout = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    const h = makeHarness({ txFail: (sql) => (sql.includes('pg_advisory_xact_lock') ? lockTimeout : undefined) });
    expect(await h.service.start({ actor: 'operator' })).toEqual({ ok: false, code: 'start_in_progress' });
    expect(h.taskRepo.createTask).not.toHaveBeenCalled();
  });

  it('refuses without a persistent config store (knowledge graph off)', async () => {
    const h = makeHarness({ persistentStore: false });
    expect(await h.service.start({ actor: 'operator' })).toEqual({ ok: false, code: 'no_persistent_store' });
    expect(h.taskRepo.createTask).not.toHaveBeenCalled();
    expect(await isTriageHeld(h.configStore)).toBe(false);
  });

  it('fails the start, and undoes it, when the store soft-rejects the hold', async () => {
    const h = makeHarness({ enabled: ALL_REQUIRED_ENABLED });
    h.configStore.set.mockResolvedValueOnce({ stored: false, action: 'rejected' });
    await expect(h.service.start({ actor: 'operator', confirmWorkingPrincipal: true })).rejects.toThrow(/rejected the triage hold/);
    expect(h.taskRepo.createTask).not.toHaveBeenCalled();
  });

  it('a principal start mints no invitation, wakes no greeting, keeps the web thread and counts the greeting as sent', async () => {
    // App route with no APP_ORIGIN: an operator start would refuse, but the principal is already here.
    const h = makeHarness({ appOrigin: undefined, enabled: ALL_REQUIRED_ENABLED });
    const result = await h.service.start({ actor: 'principal', confirmWorkingPrincipal: true });
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
    expect(result.invitation).toBeNull();
    expect(h.mintInvitation).not.toHaveBeenCalled();
    expect(h.txQueries.some((q) => q.includes('web_thread'))).toBe(false);

    const homework = h.tasks.find((t) => t.tags.includes('onboarding:homework'))!;
    const woken = h.scheduler.enqueueTaskWake.mock.calls.map((c) => ((c as unknown[])[0] as { taskId: string }).taskId);
    expect(woken).toEqual([homework.id]);
    const parentCall = h.taskRepo.createTask.mock.calls.find(([p]) => !p.parentTaskId)!;
    expect(parentCall[0].progressNote).toBeUndefined();

    const state = await readOnboardingState(h.configStore);
    expect(state).toMatchObject({ taskId: result.taskId, route: 'app' });
    expect(state?.greetingSentAt).not.toBeNull();
    expect(await isTriageHeld(h.configStore)).toBe(true);
  });

  it('a principal start on an install with no messaging route starts and records a null route; an operator start is refused', async () => {
    const operator = makeHarness({ setup: { messaging_route: null } });
    expect(await operator.service.start({ actor: 'operator', confirmWorkingPrincipal: true })).toEqual({ ok: false, code: 'route_unreachable' });

    const h = makeHarness({ setup: { messaging_route: null }, enabled: ALL_REQUIRED_ENABLED });
    const result = await h.service.start({ actor: 'principal', confirmWorkingPrincipal: true });
    expect(result.ok).toBe(true);
    expect((await readOnboardingState(h.configStore))?.route).toBeNull();
  });

  it('a principal start from another channel rotates the web thread; one from the web app does not', async () => {
    const signal = makeHarness({ enabled: ALL_REQUIRED_ENABLED });
    await signal.service.start({ actor: 'principal', confirmWorkingPrincipal: true, channelId: 'signal' });
    expect(signal.txQueries.some((q) => q.includes('web_thread'))).toBe(true);

    const web = makeHarness({ enabled: ALL_REQUIRED_ENABLED });
    await web.service.start({ actor: 'principal', confirmWorkingPrincipal: true, channelId: 'web' });
    expect(web.txQueries.some((q) => q.includes('web_thread'))).toBe(false);
  });

  it('a principal start that restarts Curia exits after 15 seconds and wakes the parent to resume the conversation', async () => {
    const h = makeHarness({ setup: { messaging_route: 'signal' } });
    const result = await h.service.start({ actor: 'principal', confirmWorkingPrincipal: true });
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
    expect(result.restartScheduled).toBe(true);
    expect(h.scheduleProcessExit).toHaveBeenCalledWith(15_000);
    const wakes = h.scheduler.enqueueTaskWake.mock.calls.map((c) => (c as unknown[])[0] as { taskId: string; runAt: Date });
    const parentWake = wakes.find((w) => w.taskId === result.taskId);
    expect(parentWake?.runAt.getTime()).toBeGreaterThan(Date.now());
    const parentCall = h.taskRepo.createTask.mock.calls.find(([p]) => !p.parentTaskId)!;
    expect(parentCall[0].progressNote).toBe(RESTART_RESUME_NOTE);
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
    // Migration 132 sets completed_at on an install that predates the Setup page; the setting's
    // writer is what tells them apart (#2709), not which catalog steps are required.
    const h = makeHarness({ setup: { completed_on_page: false } });
    const status = await h.service.status();
    expect(status).toMatchObject({ started: false, showDashboardAlert: false, principalName: 'Avery Example' });
  });

  it('counts every prior principal task on a migration-marked install', async () => {
    const h = makeHarness({ setup: { completed_on_page: false } });
    await h.service.status();
    // No cutoff: the migration time is not when Setup finished on the page.
    expect(h.taskQueryParams[0]?.[0]).toBeNull();
  });

  it('counts only tasks from before Setup finished on the page', async () => {
    const h = makeHarness();
    await h.service.status();
    expect(h.taskQueryParams[0]?.[0]).toBeInstanceOf(Date);
  });

  it('shows the alert after Setup completed and before onboarding starts', async () => {
    const h = makeHarness();
    expect(await h.service.status()).toMatchObject({ showDashboardAlert: true, triageHeld: false });
    await h.service.start({ actor: 'operator' });
    expect(await h.service.status()).toMatchObject({ started: true, showDashboardAlert: false, triageHeld: true });
  });

  it('a cancelled onboarding is not started (the alert returns); a completed one stays started', async () => {
    const h = makeHarness({ enabled: ALL_REQUIRED_ENABLED });
    const result = await h.service.start({ actor: 'operator', confirmWorkingPrincipal: true });
    if (!result.ok) throw new Error('expected ok');
    const parent = h.tasks.find((t) => t.id === result.taskId)! as { status: string };

    parent.status = 'cancelled';
    expect(await h.service.status()).toMatchObject({ started: false, taskId: null, showDashboardAlert: true });

    parent.status = 'done';
    expect(await h.service.status()).toMatchObject({ started: true, taskId: result.taskId, showDashboardAlert: false });
  });
});
