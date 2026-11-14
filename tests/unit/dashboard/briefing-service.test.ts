// BriefingService's model cache (#2350): a page load is served from memory,
// a stale model is served while a refresh runs behind it, and the background
// warmer keeps it fresh. Postgres behaviour is in tests/integration.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BriefingService, type BriefingDeps } from '../../../src/dashboard/briefing-service.js';
import { AGGREGATE_CACHE_MS, AGGREGATE_STALE_MS } from '../../../src/dashboard/briefing.js';
import { createSilentLogger } from '../../../src/logger.js';

const NOW = new Date('2026-11-03T15:00:00.000Z');

function service(query: ReturnType<typeof vi.fn>): BriefingService {
  const deps: BriefingDeps = {
    pool: { query, connect: async () => ({ query, release: vi.fn() }) } as unknown as BriefingDeps['pool'],
    actionLogRepo: {
      findAllPending: vi.fn(),
      findById: vi.fn(),
      resolveRow: vi.fn(),
      rejectStaleApproval: vi.fn(),
      insert: vi.fn(),
    },
    taskRepo: { listTasks: vi.fn(), updateTask: vi.fn() },
    contactService: { findContactBySystemRole: vi.fn().mockResolvedValue({ id: 'p', timezone: 'UTC' }) },
    officeTimezone: 'UTC',
    logger: createSilentLogger(),
  };
  return new BriefingService(deps);
}

/** A pool whose histogram read reports `n` hiccups on today, and counts its calls. */
function pool() {
  let hiccups = 0;
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('WITH RECURSIVE chain')) {
      hiccups += 1;
      return {
        rows: [{
          histogram: [{ day: '2026-11-03', actor: 'coordinator', outcome: 'failed', n: hiccups }],
          saved_calls: [],
          undescribed_by_day: [],
          hiccup_roots: [],
          // Today and six days back are in the 7-day window; eight days back is not (#2587).
          held_by_day: [{ day: '2026-11-03', n: 2 }, { day: '2026-10-28', n: 1 }, { day: '2026-10-26', n: 5 }],
        }],
      };
    }
    return { rows: [{ total: 3, overdue: 1 }] };
  });
  const modelReads = () => query.mock.calls.filter(([sql]) => String(sql).includes('WITH RECURSIVE chain')).length;
  return { query, modelReads };
}

describe('BriefingService model cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shares one read between stats and the histogram, and reports open tasks', async () => {
    const { query, modelReads } = pool();
    const s = service(query);
    const stats = await s.stats(NOW);
    await s.histogram(NOW);
    expect(modelReads()).toBe(1);
    expect(stats.openTasks).toEqual({ total: 3, overdue: 1 });
    expect(stats).not.toHaveProperty('contacts');
  });

  it('sums held-for-you jobs over the 7-day tile window, apart from hiccups (#2587)', async () => {
    const { query } = pool();
    const stats = await service(query).stats(NOW);
    expect(stats.held).toEqual({ current: 3 });
    // Holds never feed the hiccup number.
    expect(stats.hiccups.current).toBe(1);
  });

  it('reads the model with JIT off, and resets it before the connection goes back', async () => {
    const { query } = pool();
    await service(query).stats(NOW);
    const sqls = query.mock.calls.map(([sql]) => String(sql));
    const read = sqls.findIndex((sql) => sql.includes('WITH RECURSIVE chain'));
    expect(sqls[read - 1]).toBe('SET jit = off');
    expect(sqls[read + 1]).toBe('RESET jit');
  });

  it('destroys the connection when the model read fails', async () => {
    const release = vi.fn();
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('WITH RECURSIVE chain')) throw new Error('canceled');
      return { rows: [{ total: 0, overdue: 0 }] };
    });
    const s = new BriefingService({
      pool: { query, connect: async () => ({ query, release }) } as unknown as BriefingDeps['pool'],
      actionLogRepo: { findAllPending: vi.fn(), findById: vi.fn(), resolveRow: vi.fn(), rejectStaleApproval: vi.fn(), insert: vi.fn() },
      taskRepo: { listTasks: vi.fn(), updateTask: vi.fn() },
      contactService: { findContactBySystemRole: vi.fn().mockResolvedValue({ id: 'p', timezone: 'UTC' }) },
      officeTimezone: 'UTC',
      logger: createSilentLogger(),
    });
    await expect(s.stats(NOW)).rejects.toThrow('canceled');
    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });

  it('serves a stale model at once and refreshes it behind the response', async () => {
    const { query, modelReads } = pool();
    const s = service(query);
    expect((await s.stats(NOW)).hiccups.current).toBe(1);

    vi.setSystemTime(NOW.getTime() + AGGREGATE_CACHE_MS + 1000);
    // The old count comes back; the refresh it started lands for the next load.
    expect((await s.stats(NOW)).hiccups.current).toBe(1);
    await vi.waitFor(() => expect(modelReads()).toBe(2));
    expect((await s.stats(NOW)).hiccups.current).toBe(2);
    expect(modelReads()).toBe(2);
  });

  it('waits for a fresh read once the model is too old to serve', async () => {
    const { query, modelReads } = pool();
    const s = service(query);
    await s.stats(NOW);
    vi.setSystemTime(NOW.getTime() + AGGREGATE_STALE_MS + 1000);
    expect((await s.stats(NOW)).hiccups.current).toBe(2);
    expect(modelReads()).toBe(2);
  });

  it('re-reads in the background while warming, and stops when told', async () => {
    const { query, modelReads } = pool();
    const s = service(query);
    s.startWarming();
    await vi.waitFor(() => expect(modelReads()).toBe(1));
    await vi.advanceTimersByTimeAsync(AGGREGATE_CACHE_MS);
    expect(modelReads()).toBe(2);
    // A page load right after a tick is served from memory.
    await s.stats(new Date());
    expect(modelReads()).toBe(2);
    s.stopWarming();
    await vi.advanceTimersByTimeAsync(AGGREGATE_CACHE_MS * 3);
    expect(modelReads()).toBe(2);
  });
});
