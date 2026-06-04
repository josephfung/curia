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
    vi.spyOn(tasksQueries, 'selectHeartbeatCandidates').mockResolvedValue([
      { id: 't1', agentId: 'ceo-inbox' },
      { id: 't2', agentId: 'coordinator' },
    ]);
    const { hb, enqueueTaskWake } = makeHeartbeat();
    const count = await hb.tick();
    expect(count).toBe(2);
    expect(enqueueTaskWake).toHaveBeenCalledTimes(2);
    expect(enqueueTaskWake).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't1', agentId: 'ceo-inbox' }));
    expect(enqueueTaskWake).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't2', agentId: 'coordinator' }));
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
      { id: 't1', agentId: 'ceo-inbox' },
      { id: 't2', agentId: 'coordinator' },
    ]);
    const { hb, enqueueTaskWake } = makeHeartbeat();
    enqueueTaskWake.mockRejectedValueOnce(new Error('db blip'));
    const count = await hb.tick();
    expect(count).toBe(1); // second succeeds despite first failing
    expect(enqueueTaskWake).toHaveBeenCalledTimes(2);
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
