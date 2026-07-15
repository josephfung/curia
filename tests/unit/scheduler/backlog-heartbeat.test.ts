import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BacklogHeartbeat } from '../../../src/scheduler/backlog-heartbeat.js';
import * as tasksQueries from '../../../src/db/queries/tasks.js';

function mockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() };
}

function makeHeartbeat(overrides: Partial<ConstructorParameters<typeof BacklogHeartbeat>[0]> = {}) {
  const enqueueTaskWake = vi.fn().mockResolvedValue({ jobId: 'job-x' });
  const schedulerService = { enqueueTaskWake } as never;
  const pool = { query: vi.fn() } as never;
  const hb = new BacklogHeartbeat({
    pool,
    logger: mockLogger() as never,
    schedulerService,
    eligibleAgents: new Set(['coordinator', 'ceo-inbox']),
    intervalMinutes: 60,
    maxWakesPerTick: 5,
    idleThresholdHours: 4,
    staleWaitThresholdHours: 48,
    ...overrides,
  });
  return { hb, enqueueTaskWake };
}

describe('BacklogHeartbeat.tick', () => {
  afterEach(() => vi.restoreAllMocks());

  it('enqueues one wake per selected candidate and returns the count', async () => {
    const principalLineage = {
      contactId: 'ceo', systemRole: 'principal' as const, channel: 'email',
      initiatedAt: '2026-06-23T00:00:00.000Z', tier: 'principal' as const,
    };
    vi.spyOn(tasksQueries, 'selectHeartbeatCandidates').mockResolvedValue([
      { id: 't1', agentId: 'ceo-inbox', originator: principalLineage, derived: false },
      { id: 't2', agentId: 'coordinator', originator: null, derived: true },
    ]);
    const { hb, enqueueTaskWake } = makeHeartbeat();
    const count = await hb.tick();
    expect(count).toBe(2);
    expect(enqueueTaskWake).toHaveBeenCalledTimes(2);
    // The candidate's lineage + derived flag must flow through to the wake (#1125).
    expect(enqueueTaskWake).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't1', agentId: 'ceo-inbox', originator: principalLineage, derived: false }));
    expect(enqueueTaskWake).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't2', agentId: 'coordinator', originator: null, derived: true }));
  });

  it('passes config thresholds and the eligible-agents list to the selector', async () => {
    const spy = vi.spyOn(tasksQueries, 'selectHeartbeatCandidates').mockResolvedValue([]);
    const { hb } = makeHeartbeat();
    await hb.tick();
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eligibleAgents: ['coordinator', 'ceo-inbox'],
        idleThresholdHours: 4,
        staleWaitThresholdHours: 48,
        maxWakes: 5,
      }),
    );
  });

  it('continues after a single enqueue failure', async () => {
    vi.spyOn(tasksQueries, 'selectHeartbeatCandidates').mockResolvedValue([
      { id: 't1', agentId: 'ceo-inbox', originator: null, derived: false },
      { id: 't2', agentId: 'coordinator', originator: null, derived: false },
    ]);
    const { hb, enqueueTaskWake } = makeHeartbeat();
    enqueueTaskWake.mockRejectedValueOnce(new Error('db blip'));
    const count = await hb.tick();
    expect(count).toBe(1); // second succeeds despite first failing
    expect(enqueueTaskWake).toHaveBeenCalledTimes(2);
  });

  it('logs an error only when a real (non-benign) failure blocks all progress', async () => {
    vi.spyOn(tasksQueries, 'selectHeartbeatCandidates').mockResolvedValue([
      { id: 't1', agentId: 'ceo-inbox', originator: null, derived: false },
    ]);
    const logger = mockLogger();
    const { hb, enqueueTaskWake } = makeHeartbeat({ logger: logger as never });
    enqueueTaskWake.mockRejectedValueOnce(new Error('db blip')); // no pg code → hard failure
    expect(await hb.tick()).toBe(0);
    expect(logger.error).toHaveBeenCalled();
  });

  it('treats a one-active-wake unique violation (23505) as a benign race: no error, but warns (#1410)', async () => {
    vi.spyOn(tasksQueries, 'selectHeartbeatCandidates').mockResolvedValue([
      { id: 't1', agentId: 'ceo-inbox', originator: null, derived: false },
    ]);
    const logger = mockLogger();
    const { hb, enqueueTaskWake } = makeHeartbeat({ logger: logger as never });
    enqueueTaskWake.mockRejectedValueOnce(
      Object.assign(new Error('dup'), { code: '23505', constraint: 'scheduled_jobs_one_active_wake_per_task_uq' }),
    );
    expect(await hb.tick()).toBe(0);
    expect(logger.error).not.toHaveBeenCalled(); // benign — must not alarm
    expect(logger.warn).toHaveBeenCalled(); // but surfaced so a suppression regression is visible
  });

  it('treats a task-gone FK violation (23503) as benign: no error and no warn', async () => {
    vi.spyOn(tasksQueries, 'selectHeartbeatCandidates').mockResolvedValue([
      { id: 't1', agentId: 'ceo-inbox', originator: null, derived: false },
    ]);
    const logger = mockLogger();
    const { hb, enqueueTaskWake } = makeHeartbeat({ logger: logger as never });
    enqueueTaskWake.mockRejectedValueOnce(Object.assign(new Error('fk'), { code: '23503' }));
    expect(await hb.tick()).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled(); // task-gone is routine, not a regression signal
  });

  it('does not raise an unexpected unique violation on a different constraint as benign', async () => {
    vi.spyOn(tasksQueries, 'selectHeartbeatCandidates').mockResolvedValue([
      { id: 't1', agentId: 'ceo-inbox', originator: null, derived: false },
    ]);
    const logger = mockLogger();
    const { hb, enqueueTaskWake } = makeHeartbeat({ logger: logger as never });
    // A 23505 on some OTHER constraint is not the one-active-wake race — it must surface as error.
    enqueueTaskWake.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505', constraint: 'some_other_uq' }));
    expect(await hb.tick()).toBe(0);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('BacklogHeartbeat start/stop', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ticks on the configured interval and stops cleanly', async () => {
    vi.spyOn(tasksQueries, 'selectHeartbeatCandidates').mockResolvedValue([]);
    const { hb } = makeHeartbeat({ intervalMinutes: 60 });
    hb.start();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(tasksQueries.selectHeartbeatCandidates).toHaveBeenCalledTimes(1);
    hb.stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000 * 3);
    expect(tasksQueries.selectHeartbeatCandidates).toHaveBeenCalledTimes(1); // no more after stop
  });
});
