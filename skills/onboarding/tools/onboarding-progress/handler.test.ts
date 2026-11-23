import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import pino from 'pino';
import { OnboardingProgressHandler } from './handler.js';
import { OnboardingService, type OnboardingServiceDeps } from '../../../../src/onboarding/onboarding-service.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { TaskRow } from '../../../../src/db/queries/tasks.js';
import type { CreateTaskParams, ListTasksFilters } from '../../../../src/db/task-repo.js';
import type { WorkingDocsRepo } from '../../../../src/db/working-docs-repo.js';

const logger = pino({ level: 'silent' });
const PRINCIPAL_CONTACT_ID = '00000000-0000-4000-8000-0000000000a1';

// Synthetic playbook: two first-conversation topics and a one-topic ongoing rhythm.
const PLAYBOOK = [
  '# First conversation <!-- session: first-conversation -->',
  '## Hello <!-- topic: hello -->',
  'I greet {principal}.',
  "## What you'll notice <!-- topic: inbox-expectations -->",
  'Needs: mailbox',
  'I tell {principal} what to expect.',
  '# Ongoing rhythm <!-- session: ongoing-rhythm -->',
  '## Propose a rhythm <!-- topic: propose-rhythm -->',
  'I propose a cadence to {principal}.',
].join('\n');

function task(p: Partial<TaskRow> & { id: string }): TaskRow {
  return { status: 'open', tags: [], parentTaskId: null, createdBy: 'onboarding', title: p.id, ...p } as TaskRow;
}

function makeWorld(opts: { withParent?: boolean } = {}) {
  const tasks: TaskRow[] = [];
  if (opts.withParent ?? true) tasks.push(task({ id: 'parent', tags: ['onboarding'], status: 'waiting', waitingOnContactId: PRINCIPAL_CONTACT_ID }));
  let nextId = 1;
  const notes = new Map<string, string | undefined>();
  const taskRepo = {
    createTask: vi.fn(async (p: CreateTaskParams) => {
      const row = task({
        id: `sub-${nextId++}`,
        title: p.title,
        status: p.status ?? 'open',
        waitingOnContactId: p.waitingOnContactId ?? null,
        tags: p.tags ?? [],
        parentTaskId: p.parentTaskId ?? null,
        createdBy: p.createdBy ?? p.agentId,
      });
      tasks.push(row);
      return row;
    }),
    listTasks: vi.fn(async (f: ListTasksFilters) =>
      tasks.filter((t) =>
        (!f.tag || t.tags.includes(f.tag)) &&
        (!f.statuses || f.statuses.includes(t.status)) &&
        (!f.parentTaskId || t.parentTaskId === f.parentTaskId) &&
        (!f.createdBy || t.createdBy === f.createdBy)),
    ),
    completeTask: vi.fn(async (id: string, note?: string) => {
      const t = tasks.find((x) => x.id === id)!;
      if (t.status === 'done' || t.status === 'cancelled') throw new Error('already terminal');
      t.status = 'done';
      notes.set(id, note);
      return t;
    }),
    updateTask: vi.fn(async (id: string, u: { tags?: string[]; status?: string }) => {
      const t = tasks.find((x) => x.id === id)!;
      if (u.tags) t.tags = u.tags;
      if (u.status) t.status = u.status as TaskRow['status'];
      return t;
    }),
    setActiveSkillsBlock: vi.fn(),
  };
  const store = new Map<string, string>();
  const configStore = {
    get: vi.fn(async (ns: string, key: string) => store.get(`${ns}/${key}`) ?? null),
    set: vi.fn(async (ns: string, key: string, value: string) => {
      store.set(`${ns}/${key}`, value);
      return { stored: true, action: 'set' };
    }),
  };
  // Setup's keys in the settings store (#2709): the operator means "someone else".
  const setupSettings = [
    { key: 'operator', value: { name: 'Jordan Operator', email: 'jordan@example.com' } },
    { key: 'messaging_route', value: 'signal' },
    { key: 'setup.completed_at', value: '2026-01-01T00:00:00.000Z' },
  ];
  const pool = {
    query: vi.fn(async (sql: string) => ({ rows: sql.includes('FROM settings') ? setupSettings : [] })),
    connect: vi.fn(async () => ({ query: vi.fn(async () => ({ rows: [] })), release: vi.fn() })),
  };
  // The onboarding run state (#2360): the operator-notice dedupe reads and writes it.
  store.set(
    'onboarding/state',
    JSON.stringify({
      taskId: 'parent',
      startedAt: '2026-01-01T00:00:00.000Z',
      route: 'app',
      greetingSentAt: null,
      followUpsSent: 0,
      lastFollowUpAt: null,
      lastPrincipalTurnAt: null,
      idleNudgeSentAt: null,
      operatorNotified: [],
    }),
  );
  const service = new OnboardingService({
    pool: pool as unknown as Pool,
    taskRepo: taskRepo as unknown as OnboardingServiceDeps['taskRepo'],
    registry: { list: vi.fn(), installAndEnable: vi.fn() },
    scheduler: { enqueueTaskWake: vi.fn() },
    configStore,
    stateLock: (fn) => fn(),
    workingDocsRepo: { read: vi.fn(async () => ({ body: PLAYBOOK, frontmatter: { editable_by: 'console' } })), create: vi.fn() } as unknown as WorkingDocsRepo,
    principalName: async () => 'Avery Example',
    principalContactId: async () => PRINCIPAL_CONTACT_ID,
    principalHasIdentity: async () => true,
    appOrigin: undefined,
    scheduleProcessExit: vi.fn(),
    loadedAtBoot: () => true,
    persistentStore: true,
    logger,
  });
  const run = (input: Record<string, unknown>, extra: Partial<ToolContext> = {}) =>
    new OnboardingProgressHandler().execute({
      input,
      log: logger,
      agentId: 'coordinator',
      onboardingService: service,
      taskRepo,
      ...extra,
    } as unknown as ToolContext);
  const sub = (topicId: string) => tasks.find((t) => t.tags.includes(`onboarding:topic:${topicId}`))!;
  return { run, tasks, taskRepo, notes, sub };
}

describe('onboarding-progress', () => {
  it('open_session creates the session subtasks once', async () => {
    const w = makeWorld();
    const first = await w.run({ op: 'open_session', session_id: 'first-conversation' });
    expect(first.success).toBe(true);
    const second = await w.run({ op: 'open_session', session_id: 'first-conversation' });
    expect(second.success).toBe(true);
    expect(w.taskRepo.createTask).toHaveBeenCalledTimes(2);
    expect(w.sub('hello').tags).toEqual(['onboarding', 'onboarding:topic:hello', 'onboarding:session:first-conversation']);
    // Topics wait on the principal: not backlog-heartbeat candidates.
    expect(w.sub('hello')).toMatchObject({ status: 'waiting', waitingOnContactId: PRINCIPAL_CONTACT_ID });
  });

  it('topic_done completes the subtask, and the last open ongoing-rhythm subtask completes the parent', async () => {
    const w = makeWorld();
    await w.run({ op: 'open_session', session_id: 'first-conversation' });
    await w.run({ op: 'open_session', session_id: 'ongoing-rhythm' });

    const hello = await w.run({ op: 'topic_done', topic_id: 'hello', outcome: 'done', note: 'Prefers chat.' });
    expect(hello.success).toBe(true);
    expect(w.sub('hello').status).toBe('done');
    expect(w.notes.get(w.sub('hello').id)).toContain('Prefers chat.');

    // The rhythm topic is done, but an inbox topic is still open: the parent stays open.
    await w.run({ op: 'topic_done', topic_id: 'propose-rhythm', outcome: 'declined', note: 'No weekly session.' });
    expect(w.notes.get(w.sub('propose-rhythm').id)).toMatch(/declined/i);
    expect(w.tasks.find((t) => t.id === 'parent')!.status).toBe('waiting');

    const last = await w.run({ op: 'topic_done', topic_id: 'inbox-expectations', outcome: 'done', note: 'Labels on.' });
    expect(last.success).toBe(true);
    expect(w.tasks.find((t) => t.id === 'parent')!.status).toBe('done');
  });

  it('completes on the topics alone: an open homework task is cancelled, a model-parented task is left', async () => {
    const w = makeWorld();
    w.tasks.push(task({ id: 'homework', parentTaskId: 'parent', tags: ['onboarding', 'onboarding:homework'] }));
    w.tasks.push(task({ id: 'side', parentTaskId: 'parent', createdBy: 'coordinator', tags: [] }));
    await w.run({ op: 'open_session', session_id: 'first-conversation' });
    await w.run({ op: 'open_session', session_id: 'ongoing-rhythm' });
    for (const topic of ['hello', 'inbox-expectations', 'propose-rhythm']) {
      await w.run({ op: 'topic_done', topic_id: topic, outcome: 'done', note: 'ok' });
    }
    expect(w.tasks.find((t) => t.id === 'parent')!.status).toBe('done');
    expect(w.tasks.find((t) => t.id === 'homework')!.status).toBe('cancelled');
    expect(w.tasks.find((t) => t.id === 'side')!.status).toBe('open');
  });

  it('a completion that fails on the last topic_done is retried by status', async () => {
    const w = makeWorld();
    await w.run({ op: 'open_session', session_id: 'first-conversation' });
    await w.run({ op: 'open_session', session_id: 'ongoing-rhythm' });
    await w.run({ op: 'topic_done', topic_id: 'hello', outcome: 'done', note: 'ok' });
    await w.run({ op: 'topic_done', topic_id: 'inbox-expectations', outcome: 'done', note: 'ok' });
    const real = w.taskRepo.completeTask.getMockImplementation()!;
    w.taskRepo.completeTask.mockImplementation(async (id: string, note?: string) => {
      if (id === 'parent') throw new Error('db blip');
      return real(id, note);
    });
    const last = await w.run({ op: 'topic_done', topic_id: 'propose-rhythm', outcome: 'done', note: 'ok' });
    expect(last).toMatchObject({ success: true, data: { onboardingComplete: false } });
    expect(w.sub('propose-rhythm').status).toBe('done');
    expect(w.tasks.find((t) => t.id === 'parent')!.status).toBe('waiting');

    w.taskRepo.completeTask.mockImplementation(real);
    const status = await w.run({ op: 'status' });
    expect(status).toMatchObject({ success: true, data: { onboardingComplete: true } });
    expect(w.tasks.find((t) => t.id === 'parent')!.status).toBe('done');
  });

  it('status still returns the topics when completing the onboarding task fails', async () => {
    const w = makeWorld();
    await w.run({ op: 'open_session', session_id: 'first-conversation' });
    await w.run({ op: 'open_session', session_id: 'ongoing-rhythm' });
    await w.run({ op: 'topic_done', topic_id: 'hello', outcome: 'done', note: 'ok' });
    await w.run({ op: 'topic_done', topic_id: 'inbox-expectations', outcome: 'done', note: 'ok' });
    w.taskRepo.completeTask.mockImplementation(async (id: string) => {
      if (id === 'parent') throw new Error('db blip');
      return w.tasks.find((t) => t.id === id)!;
    });
    await w.run({ op: 'topic_done', topic_id: 'propose-rhythm', outcome: 'done', note: 'ok' });
    const status = await w.run({ op: 'status' });
    expect(status).toMatchObject({ success: true, data: { onboardingComplete: false } });
  });

  it('does not complete the parent while the ongoing-rhythm session has not been opened', async () => {
    const w = makeWorld();
    await w.run({ op: 'open_session', session_id: 'first-conversation' });
    await w.run({ op: 'topic_done', topic_id: 'hello', outcome: 'done', note: 'ok' });
    await w.run({ op: 'topic_done', topic_id: 'inbox-expectations', outcome: 'done', note: 'ok' });
    expect(w.tasks.find((t) => t.id === 'parent')!.status).toBe('waiting');
  });

  it('an unknown topic_id fails naming the open topic ids; a topic tag not created by onboarding does not count', async () => {
    const w = makeWorld();
    await w.run({ op: 'open_session', session_id: 'first-conversation' });
    w.tasks.push(task({ id: 'spoof', parentTaskId: 'parent', createdBy: 'coordinator', tags: ['onboarding', 'onboarding:topic:spoof'] }));

    const result = await w.run({ op: 'topic_done', topic_id: 'spoof', outcome: 'done', note: 'x' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('hello');
    expect(result.error).toContain('inbox-expectations');
    expect(w.tasks.find((t) => t.id === 'spoof')!.status).toBe('open');
  });

  it('topic_done refuses when there is no open onboarding task', async () => {
    const w = makeWorld({ withParent: false });
    const result = await w.run({ op: 'topic_done', topic_id: 'hello', outcome: 'done', note: 'x' });
    expect(result.success).toBe(false);
    expect(w.taskRepo.completeTask).not.toHaveBeenCalled();
  });

  it('status fills in the principal name and gives who Setup was for', async () => {
    const w = makeWorld();
    await w.run({ op: 'open_session', session_id: 'first-conversation' });
    const result = await w.run({ op: 'status' });
    if (!result.success) throw new Error(result.error);
    const text = JSON.stringify(result.data);
    expect(text).toContain('Avery Example');
    expect(text).not.toContain('{principal}');
    expect(result.data).toMatchObject({ setupFor: 'other', operatorName: 'Jordan Operator' });
  });

  it('status reads an unreadable mailbox directory as not connected', async () => {
    const w = makeWorld();
    const mailboxDirectory = { list: vi.fn(async () => { throw new Error('directory down'); }) };
    const result = await w.run({ op: 'status' }, { mailboxDirectory } as Partial<ToolContext>);
    if (!result.success) throw new Error(result.error);
    expect(result.data).toMatchObject({ mailboxConnected: false });
  });

  it('a declined topic is tagged declined', async () => {
    const w = makeWorld();
    await w.run({ op: 'open_session', session_id: 'first-conversation' });
    await w.run({ op: 'topic_done', topic_id: 'inbox-expectations', outcome: 'declined', note: 'Not now.' });
    expect(w.sub('inbox-expectations').tags).toContain('onboarding:declined');
  });

  it('operator_notice records the notice on the onboarding task', async () => {
    const w = makeWorld();
    const result = await w.run({ op: 'operator_notice', event: 'web_search_failed' });
    expect(result).toEqual({ success: true, data: { recorded: true } });
    expect(w.taskRepo.updateTask).toHaveBeenCalledWith('parent', { progressNote: 'Operator notice: web_search_failed' });
  });

  it('operator_notice is raised once per run: a second call reports alreadyRaised, not a failure', async () => {
    const w = makeWorld();
    const first = await w.run({ op: 'operator_notice', event: 'web_search_failed' });
    expect(first).toEqual({ success: true, data: { recorded: true } });
    // Success, so the model does not retry a notice the dedupe is deliberately holding back.
    const second = await w.run({ op: 'operator_notice', event: 'web_search_failed' });
    expect(second).toEqual({ success: true, data: { alreadyRaised: true } });
    // One note on the task, whatever the model does with the tool.
    expect(w.taskRepo.updateTask).toHaveBeenCalledTimes(1);
  });

  it('operator_notice refuses the events the code raises itself', async () => {
    const w = makeWorld();
    for (const event of ['greeting_unanswered', 'invitation_expired', 'mailbox_signin_blocked']) {
      const result = await w.run({ op: 'operator_notice', event });
      expect(result.success, event).toBe(false);
    }
    expect(w.taskRepo.updateTask).not.toHaveBeenCalled();
  });

  it('operator_notice fails when the notice could not be written', async () => {
    const w = makeWorld();
    w.taskRepo.updateTask.mockImplementation(async () => { throw new Error('db down'); });
    const result = await w.run({ op: 'operator_notice', event: 'web_search_failed' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/could not be recorded/);
  });
});
