// approval-expiry-sweep.test.ts — the system-interval approval expiry sweep (#2013).
//
// Ported from the retired approval-expiry-sweep skill's handler tests, plus the interval
// behaviour the coordinator cron used to give us: a failing tick logs at error and the
// next interval still fires, and an overlapping interval is skipped with a warning.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApprovalExpirySweep } from '../../../src/autonomy/approval-expiry-sweep.js';
import type { ActionLogRepo } from '../../../src/autonomy/action-log-repo.js';
import type { ActionLogRow } from '../../../src/autonomy/action-log-types.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { BusEvent, PrincipalReportEvent } from '../../../src/bus/events.js';
import type { Logger } from '../../../src/logger.js';

// --- Fixtures ---

function makeRow(overrides: Partial<ActionLogRow> = {}): ActionLogRow {
  return {
    id: 1,
    shortRef: 'cal-1',
    toolName: 'create-calendar-event',
    description: 'Create event: Lunch',
    actionRisk: 'medium',
    outcome: 'pending_approval',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() - 1000), // already expired
    resolvedAt: null,
    resolvedBy: null,
    taskId: 'task-1',
    conversationId: null,
    taskSummary: null,
    competenceFlag: null,
    commitmentFlag: null,
    compatibility: null,
    scoredBy: null,
    payload: {},
    notificationSentAt: null,
    parentActionId: null,
    ...overrides,
  };
}

function makeSweep(overrides: {
  findExpiredRows?: ActionLogRow[];
  // Rows actually returned by expireRows (RETURNING *). Defaults to findExpiredRows —
  // the common case where nothing was resolved concurrently.
  expireRowsResult?: ActionLogRow[];
  // Event types whose publish rejects, to simulate a bus failure.
  failPublishFor?: string[];
} = {}) {
  const {
    findExpiredRows = [],
    expireRowsResult = findExpiredRows,
    failPublishFor = [],
  } = overrides;

  const findExpired = vi.fn().mockResolvedValue(findExpiredRows);
  const expireRows = vi.fn().mockResolvedValue(expireRowsResult);
  const published: BusEvent[] = [];
  const publish = vi.fn(async (_layer: string, event: BusEvent) => {
    if (failPublishFor.includes(event.type)) throw new Error('bus down');
    published.push(event);
  });
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const sweep = new ApprovalExpirySweep({
    actionLogRepo: { findExpired, expireRows } as unknown as ActionLogRepo,
    bus: { publish } as unknown as EventBus,
    logger: logger as unknown as Logger,
    intervalMinutes: 60,
  });

  return { sweep, findExpired, expireRows, publish, published, logger };
}

const reports = (events: BusEvent[]) =>
  events.filter((e): e is PrincipalReportEvent => e.type === 'principal.report');

afterEach(() => {
  vi.useRealTimers();
});

// --- tick() ---

describe('ApprovalExpirySweep.tick (#2013)', () => {
  it('does nothing when no approvals have expired', async () => {
    const { sweep, expireRows, publish } = makeSweep({ findExpiredRows: [] });

    const result = await sweep.tick();

    expect(result).toEqual({ expired: 0, notified: 0 });
    expect(expireRows).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  // #2159: every expiry is one digest line, whatever its risk; nothing is emailed.
  it('expires every row and queues one digest item per row, of every tier', async () => {
    const rows = [
      makeRow({ id: 1, shortRef: 'low-ref', actionRisk: 'low', description: 'Store fact: Dana prefers mornings' }),
      makeRow({ id: 2, shortRef: 'crit-ref', actionRisk: 'critical', taskId: 'task-9', description: 'Send email reply: Re: Venue' }),
    ];
    const { sweep, expireRows, published } = makeSweep({ findExpiredRows: rows });

    const result = await sweep.tick();

    expect(expireRows).toHaveBeenCalledWith([1, 2]);
    const items = reports(published);
    expect(items).toHaveLength(2);
    expect(items[1]!.sourceLayer).toBe('system');
    expect(items[1]!.parentEventId).toBe('task-9');
    expect(items[1]!.payload).toEqual({
      summary: 'Approval expired without an answer: Send email reply: Re: Venue',
      urgency: 'digest',
      source: 'approval_expired',
      actionShortRef: 'crit-ref',
    });
    expect(published.some((e) => e.type === 'outbound.notification')).toBe(false);
    expect(result).toEqual({ expired: 2, notified: 2 });
  });

  it('falls back to the tool name when a row has no description', async () => {
    const { sweep, published } = makeSweep({ findExpiredRows: [makeRow({ id: 1, description: null, toolName: 'email-reply' })] });

    await sweep.tick();

    expect(reports(published)[0]!.payload.summary).toBe('Approval expired without an answer: email-reply');
  });

  it('only reports rows that actually expired (concurrent resolution)', async () => {
    const highRow = makeRow({ id: 1, shortRef: 'high-ref', actionRisk: 'high' });
    const critRow = makeRow({ id: 2, shortRef: 'crit-ref', actionRisk: 'critical' });
    const { sweep, published, logger } = makeSweep({
      findExpiredRows: [highRow, critRow],
      expireRowsResult: [highRow], // the critical row was resolved before the UPDATE ran
    });

    const result = await sweep.tick();

    expect(logger.warn).toHaveBeenCalled();
    expect(reports(published).map((r) => r.payload.actionShortRef)).toEqual(['high-ref']);
    expect(result).toEqual({ expired: 1, notified: 1 });
  });

  it('logs a failed queue at error, naming the row, and carries on with the rest', async () => {
    const rows = [makeRow({ id: 1, shortRef: 'a-ref' }), makeRow({ id: 2, shortRef: 'b-ref' })];
    const { sweep, publish, logger } = makeSweep({ findExpiredRows: rows });
    publish.mockImplementationOnce(async () => { throw new Error('bus down'); });

    const result = await sweep.tick();

    // Expiry has committed and the row won't come back, so the log is the only record.
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, shortRef: 'a-ref' }),
      expect.stringContaining('failed to queue'),
    );
    expect(publish).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ expired: 2, notified: 1 });
  });

  it('rejects when the repository call throws, without queueing', async () => {
    const { sweep, findExpired, publish } = makeSweep();
    findExpired.mockRejectedValue(new Error('DB down'));

    await expect(sweep.tick()).rejects.toThrow('DB down');
    expect(publish).not.toHaveBeenCalled();
  });
});

// --- start() / stop() ---

describe('ApprovalExpirySweep interval (#2013)', () => {
  // The boot tick fires FIRST_TICK_DELAY_MS (60s) after start(), then every interval.
  const BOOT_MS = 60_000;
  const HOUR_MS = 60 * 60_000;

  it('sweeps shortly after boot, without waiting a full interval', async () => {
    vi.useFakeTimers();
    const { sweep, findExpired } = makeSweep();

    sweep.start();
    await vi.advanceTimersByTimeAsync(BOOT_MS - 1);
    expect(findExpired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(findExpired).toHaveBeenCalledTimes(1);

    sweep.stop();
  });

  it('ticks on the configured interval and stops cleanly', async () => {
    vi.useFakeTimers();
    const { sweep, findExpired } = makeSweep();

    sweep.start();
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(findExpired).toHaveBeenCalledTimes(2); // boot tick + first interval

    sweep.stop();
    await vi.advanceTimersByTimeAsync(3 * HOUR_MS);
    expect(findExpired).toHaveBeenCalledTimes(2);
  });

  it('stop() before the boot tick cancels it', async () => {
    vi.useFakeTimers();
    const { sweep, findExpired } = makeSweep();

    sweep.start();
    sweep.stop();
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(findExpired).not.toHaveBeenCalled();
  });

  it('logs a failing tick at error and still runs the next interval', async () => {
    vi.useFakeTimers();
    const { sweep, findExpired, logger } = makeSweep();
    findExpired.mockRejectedValueOnce(new Error('DB down'));

    sweep.start();
    await vi.advanceTimersByTimeAsync(BOOT_MS);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]![0]).toMatchObject({ err: expect.any(Error), consecutiveFailures: 1 });

    // The guard is released after a failure, so the next interval runs normally.
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(findExpired).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(1);

    sweep.stop();
  });

  it('counts consecutive failures and resets the count after a success', async () => {
    vi.useFakeTimers();
    const { sweep, findExpired, logger } = makeSweep();
    findExpired
      .mockRejectedValueOnce(new Error('DB down'))
      .mockRejectedValueOnce(new Error('DB down'))
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('DB down'));

    sweep.start();
    await vi.advanceTimersByTimeAsync(BOOT_MS + 3 * HOUR_MS);

    const streaks = logger.error.mock.calls.map((c) => (c[0] as { consecutiveFailures: number }).consecutiveFailures);
    expect(streaks).toEqual([1, 2, 1]);

    sweep.stop();
  });

  it('skips an interval while the previous tick is still running, with a warning', async () => {
    vi.useFakeTimers();
    const { sweep, logger } = makeSweep();

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tickSpy = vi.spyOn(sweep, 'tick').mockImplementation(async () => {
      await gate;
      return { expired: 0, notified: 0 };
    });

    sweep.start();
    await vi.advanceTimersByTimeAsync(BOOT_MS); // boot tick starts and hangs
    await vi.advanceTimersByTimeAsync(HOUR_MS); // interval fires while it is still running
    expect(tickSpy).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('still in flight'));

    release!();
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(tickSpy).toHaveBeenCalledTimes(2);

    sweep.stop();
  });
});
