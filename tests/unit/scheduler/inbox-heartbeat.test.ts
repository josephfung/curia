import { describe, it, expect, vi } from 'vitest';
import { InboxHeartbeat, type InboxHeartbeatOptions } from '../../../src/scheduler/inbox-heartbeat.js';
import { parseCadence, TRIAGE_DAILY_CEILING, type Cadence } from '../../../src/principal-mailboxes/triage-cadence.js';
import { TriageState } from '../../../src/principal-mailboxes/triage-state.js';

const TZ = 'America/Toronto';
// 2026-11-12 10:00 Toronto (UTC-5)
const NOW = new Date('2026-11-12T15:00:00.000Z');

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() };
}

function memoryConfig(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    get: vi.fn(async (_ns: string, key: string) => m.get(key) ?? null),
    set: vi.fn(async (_ns: string, key: string, v: string) => { m.set(key, v); return { stored: true, action: 'set' }; }),
  };
}

function taskRow(over: Record<string, unknown> = {}) {
  return {
    id: 'task-1', agentId: 'ceo-inbox', tags: ['inbox-drain'], status: 'open',
    updatedAt: new Date(NOW.getTime() - 3 * 3600_000).toISOString(),
    nextWakeAt: null, wakeState: null, ...over,
  };
}

function make(over: {
  mailboxes?: Array<{ id: string; triageStartAt?: Date | null }>;
  cadences?: Record<string, Cadence>;
  seed?: Record<string, string>;
  hasUnread?: InboxHeartbeatOptions['hasUnreadSince'];
  tasks?: unknown[];
} = {}) {
  const cfg = memoryConfig(over.seed);
  const state = new TriageState(cfg, () => TZ);
  const hourly = parseCadence('hourly 06:00-23:00')!;
  const mbs = over.mailboxes ?? [{ id: 'work', triageStartAt: null }];
  const hasUnreadSince = over.hasUnread ?? vi.fn(async () => true);
  const listTasks = vi.fn(async () => (over.tasks ?? []) as never);
  const createTask = vi.fn(async () => ({ id: 'new-task' }) as never);
  const enqueueTaskWake = vi.fn(async () => ({ jobId: 'j' }));
  const log = logger();
  const hb = new InboxHeartbeat({
    mailboxes: { list: async () => mbs.map((m) => ({ id: m.id, label: m.id, address: '', isDefault: false, triageStartAt: m.triageStartAt ?? null })) },
    cadences: async () => over.cadences ?? Object.fromEntries(mbs.map((m) => [m.id, hourly])),
    state,
    hasUnreadSince,
    taskRepo: { listTasks, createTask },
    scheduler: { enqueueTaskWake },
    dailyCeiling: TRIAGE_DAILY_CEILING,
    tz: () => TZ,
    logger: log as never,
  });
  return { hb, state, hasUnreadSince, listTasks, createTask, enqueueTaskWake, log };
}

describe('InboxHeartbeat.tick', () => {
  it('quiet tick makes no task and no wake', async () => {
    const t = make({ hasUnread: vi.fn(async () => false) });
    expect(await t.hb.tick(NOW)).toBe('quiet');
    expect(t.createTask).not.toHaveBeenCalled();
    expect(t.enqueueTaskWake).not.toHaveBeenCalled();
  });

  it('wakes when a due mailbox has unread mail', async () => {
    const t = make();
    expect(await t.hb.tick(NOW)).toBe('woke');
    expect(t.createTask).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'ceo-inbox', title: 'Inbox drain', tags: ['inbox-drain'], wakeAt: NOW, createdBy: 'heartbeat',
    }));
  });

  it('does not wake while a drain is running', async () => {
    const t = make({ tasks: [taskRow({ nextWakeAt: '2026-11-12T15:01:30.000Z' })] });
    expect(await t.hb.tick(NOW)).toBe('drain_running');
    expect(t.createTask).not.toHaveBeenCalled();
    expect(t.enqueueTaskWake).not.toHaveBeenCalled();
  });

  it('treats a task whose wake is running as live', async () => {
    const t = make({ tasks: [taskRow({ wakeState: 'running' })] });
    expect(await t.hb.tick(NOW)).toBe('drain_running');
  });

  it('treats a task updated within the grace window as live', async () => {
    const t = make({ tasks: [taskRow({ updatedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString()})] });
    expect(await t.hb.tick(NOW)).toBe('drain_running');
  });

  it('re-wakes a stalled drain task instead of creating one', async () => {
    const t = make({ tasks: [taskRow()] });
    expect(await t.hb.tick(NOW)).toBe('woke');
    expect(t.enqueueTaskWake).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1', agentId: 'ceo-inbox', runAt: NOW }));
    expect(t.createTask).not.toHaveBeenCalled();
  });

  it('never creates a second task while one is open', async () => {
    const t = make({ tasks: [taskRow(), taskRow({ id: 'task-2' })] });
    await t.hb.tick(NOW);
    expect(t.createTask).not.toHaveBeenCalled();
    expect(t.enqueueTaskWake).toHaveBeenCalledTimes(1);
  });

  it('stops at the daily ceiling, using ceilingReached', async () => {
    const t = make();
    const spy = vi.spyOn(t.state, 'ceilingReached').mockResolvedValue(true);
    expect(await t.hb.tick(NOW)).toBe('ceiling');
    expect(spy).toHaveBeenCalledWith(NOW);
    expect(t.hasUnreadSince).not.toHaveBeenCalled();
    expect(t.createTask).not.toHaveBeenCalled();
  });

  it('a mailbox outside its window is not probed', async () => {
    const t = make({ cadences: { work: parseCadence('hourly 06:00-08:00')! } });
    expect(await t.hb.tick(NOW)).toBe('quiet');
    expect(t.hasUnreadSince).not.toHaveBeenCalled();
  });

  it('a mailbox that is draining is probed even outside its window', async () => {
    const t = make({ cadences: { work: parseCadence('hourly 06:00-08:00')! }, seed: { 'triage.work.draining': 'true' } });
    expect(await t.hb.tick(NOW)).toBe('woke');
    expect(t.hasUnreadSince).toHaveBeenCalledWith('work', null);
  });

  it('probes a due mailbox with its triage start', async () => {
    const start = new Date('2026-11-01T00:00:00.000Z');
    const t = make({ mailboxes: [{ id: 'work', triageStartAt: start }] });
    await t.hb.tick(NOW);
    expect(t.hasUnreadSince).toHaveBeenCalledWith('work', start);
  });

  it('a failing probe for one mailbox does not stop the other', async () => {
    const hasUnread = vi.fn(async (id: string) => {
      if (id === 'work') throw Object.assign(new Error('boom grant-abc'), { name: 'NylasApiError', statusCode: 500 });
      return true;
    });
    const t = make({ mailboxes: [{ id: 'work' }, { id: 'personal' }], hasUnread });
    expect(await t.hb.tick(NOW)).toBe('woke');
    expect(hasUnread).toHaveBeenCalledTimes(2);
    const logged = JSON.stringify(t.log.warn.mock.calls);
    expect(logged).not.toContain('grant-abc');
  });

  it('warns and stays quiet when every due probe fails', async () => {
    const hasUnread = vi.fn(async () => { throw new Error('down'); });
    const t = make({ mailboxes: [{ id: 'work' }, { id: 'personal' }], hasUnread });
    expect(await t.hb.tick(NOW)).toBe('quiet');
    expect(t.log.warn).toHaveBeenCalledWith(expect.objectContaining({ failed: 2 }), expect.stringContaining('every'));
  });
});

describe('InboxHeartbeat.start', () => {
  it('a tick that throws never escapes the interval', async () => {
    vi.useFakeTimers();
    try {
      const t = make();
      vi.spyOn(t.state, 'ceilingReached').mockRejectedValue(new Error('db down'));
      t.hb.start();
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(t.log.error).toHaveBeenCalled();
      t.hb.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
