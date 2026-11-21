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
  if (opts.withParent ?? true) tasks.push(task({ id: 'parent', tags: ['onboarding'] }));
  let nextId = 1;
  const notes = new Map<string, string | undefined>();
  const taskRepo = {
    createTask: vi.fn(async (p: CreateTaskParams) => {
      const row = task({
        id: `sub-${nextId++}`,
        title: p.title,
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
    updateTask: vi.fn(async () => null),
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
  const pool = { connect: vi.fn(async () => ({ query: vi.fn(async () => ({ rows: [] })), release: vi.fn() })) };
  const service = new OnboardingService({
    pool: pool as unknown as Pool,
    taskRepo: taskRepo as unknown as OnboardingServiceDeps['taskRepo'],
    registry: { list: vi.fn(), installAndEnable: vi.fn() },
    scheduler: { enqueueTaskWake: vi.fn() },
    configStore,
    workingDocsRepo: { read: vi.fn(async () => ({ body: PLAYBOOK })), create: vi.fn() } as unknown as WorkingDocsRepo,
    principalName: async () => 'Avery Example',
    principalHasIdentity: async () => true,
    appOrigin: undefined,
    scheduleProcessExit: vi.fn(),
    logger,
  });
  const run = (input: Record<string, unknown>) =>
    new OnboardingProgressHandler().execute({
      input,
      log: logger,
      agentId: 'coordinator',
      onboardingService: service,
      taskRepo,
    } as unknown as ToolContext);
  const sub = (topicId: string) => tasks.find((t) => t.tags.includes(`onboarding:topic:${topicId}`))!;
  return { run, tasks, taskRepo, notes, sub };
}

describe('onboarding-progress', () => {
  it('open_session creates the session subtasks once', async () => {
    const w = makeWorld();
    const first = await w.run({ action: 'open_session', session_id: 'first-conversation' });
    expect(first.success).toBe(true);
    const second = await w.run({ action: 'open_session', session_id: 'first-conversation' });
    expect(second.success).toBe(true);
    expect(w.taskRepo.createTask).toHaveBeenCalledTimes(2);
    expect(w.sub('hello').tags).toEqual(['onboarding', 'onboarding:topic:hello', 'onboarding:session:first-conversation']);
  });

  it('topic_done completes the subtask, and the last open ongoing-rhythm subtask completes the parent', async () => {
    const w = makeWorld();
    await w.run({ action: 'open_session', session_id: 'first-conversation' });
    await w.run({ action: 'open_session', session_id: 'ongoing-rhythm' });

    const hello = await w.run({ action: 'topic_done', topic_id: 'hello', outcome: 'done', note: 'Prefers chat.' });
    expect(hello.success).toBe(true);
    expect(w.sub('hello').status).toBe('done');
    expect(w.notes.get(w.sub('hello').id)).toContain('Prefers chat.');

    // The rhythm topic is done, but an inbox topic is still open: the parent stays open.
    await w.run({ action: 'topic_done', topic_id: 'propose-rhythm', outcome: 'declined', note: 'No weekly session.' });
    expect(w.notes.get(w.sub('propose-rhythm').id)).toMatch(/declined/i);
    expect(w.tasks.find((t) => t.id === 'parent')!.status).toBe('open');

    const last = await w.run({ action: 'topic_done', topic_id: 'inbox-expectations', outcome: 'done', note: 'Labels on.' });
    expect(last.success).toBe(true);
    expect(w.tasks.find((t) => t.id === 'parent')!.status).toBe('done');
  });

  it('does not complete the parent while the ongoing-rhythm session has not been opened', async () => {
    const w = makeWorld();
    await w.run({ action: 'open_session', session_id: 'first-conversation' });
    await w.run({ action: 'topic_done', topic_id: 'hello', outcome: 'done', note: 'ok' });
    await w.run({ action: 'topic_done', topic_id: 'inbox-expectations', outcome: 'done', note: 'ok' });
    expect(w.tasks.find((t) => t.id === 'parent')!.status).toBe('open');
  });

  it('an unknown topic_id fails naming the open topic ids; a topic tag not created by onboarding does not count', async () => {
    const w = makeWorld();
    await w.run({ action: 'open_session', session_id: 'first-conversation' });
    w.tasks.push(task({ id: 'spoof', parentTaskId: 'parent', createdBy: 'coordinator', tags: ['onboarding', 'onboarding:topic:spoof'] }));

    const result = await w.run({ action: 'topic_done', topic_id: 'spoof', outcome: 'done', note: 'x' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('hello');
    expect(result.error).toContain('inbox-expectations');
    expect(w.tasks.find((t) => t.id === 'spoof')!.status).toBe('open');
  });

  it('topic_done refuses when there is no open onboarding task', async () => {
    const w = makeWorld({ withParent: false });
    const result = await w.run({ action: 'topic_done', topic_id: 'hello', outcome: 'done', note: 'x' });
    expect(result.success).toBe(false);
    expect(w.taskRepo.completeTask).not.toHaveBeenCalled();
  });

  it('status fills in the principal name', async () => {
    const w = makeWorld();
    await w.run({ action: 'open_session', session_id: 'first-conversation' });
    const result = await w.run({ action: 'status' });
    if (!result.success) throw new Error(result.error);
    const text = JSON.stringify(result.data);
    expect(text).toContain('Avery Example');
    expect(text).not.toContain('{principal}');
  });
});
