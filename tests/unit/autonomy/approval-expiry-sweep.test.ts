// approval-expiry-sweep.test.ts — the system-interval approval expiry sweep (#2013).
//
// Ported from the retired approval-expiry-sweep skill's handler tests, plus the interval
// behaviour the coordinator cron used to give us: a failing tick logs at error and the
// next interval still fires, and an overlapping interval is skipped with a warning.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApprovalExpirySweep } from '../../../src/autonomy/approval-expiry-sweep.js';
import type { ActionLogRepo } from '../../../src/autonomy/action-log-repo.js';
import type { ActionLogRow } from '../../../src/autonomy/action-log-types.js';
import type { OutboundGateway } from '../../../src/skills/outbound-gateway.js';
import type { PrincipalEmailRef } from '../../../src/contacts/types.js';
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
  sendNotificationResult?: boolean;
  // '' simulates no verified + active principal email on file.
  ceoEmail?: string;
  withoutOutboundGateway?: boolean;
} = {}) {
  const {
    findExpiredRows = [],
    expireRowsResult = findExpiredRows,
    sendNotificationResult = true,
    ceoEmail = 'principal@example.com',
    withoutOutboundGateway = false,
  } = overrides;

  const findExpired = vi.fn().mockResolvedValue(findExpiredRows);
  const expireRows = vi.fn().mockResolvedValue(expireRowsResult);
  const sendNotification = vi.fn().mockResolvedValue(sendNotificationResult);
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const principalEmail: PrincipalEmailRef = { current: ceoEmail };

  const sweep = new ApprovalExpirySweep({
    actionLogRepo: { findExpired, expireRows } as unknown as ActionLogRepo,
    outboundGateway: withoutOutboundGateway
      ? undefined
      : ({ sendNotification } as unknown as OutboundGateway),
    ceoEmail: principalEmail,
    logger: logger as unknown as Logger,
    intervalMinutes: 60,
  });

  return { sweep, findExpired, expireRows, sendNotification, logger, principalEmail };
}

afterEach(() => {
  vi.useRealTimers();
});

// --- tick() ---

describe('ApprovalExpirySweep.tick (#2013)', () => {
  it('does nothing when no approvals have expired', async () => {
    const { sweep, expireRows, sendNotification } = makeSweep({ findExpiredRows: [] });

    const result = await sweep.tick();

    expect(result).toEqual({ expired: 0, notified: 0 });
    expect(expireRows).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('expires every candidate row without notifying for low/medium tiers', async () => {
    const rows = [
      makeRow({ id: 1, shortRef: 'cal-1', actionRisk: 'low' }),
      makeRow({ id: 2, shortRef: 'email-1', actionRisk: 'medium' }),
    ];
    const { sweep, expireRows, sendNotification } = makeSweep({ findExpiredRows: rows });

    const result = await sweep.tick();

    expect(expireRows).toHaveBeenCalledWith([1, 2]);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(result).toEqual({ expired: 2, notified: 0 });
  });

  it('expires and sends one batched notification for high/critical rows', async () => {
    const rows = [
      makeRow({ id: 1, shortRef: 'low-ref', actionRisk: 'low' }),
      makeRow({ id: 2, shortRef: 'high-ref', actionRisk: 'high' }),
      makeRow({ id: 3, shortRef: 'crit-ref', actionRisk: 'critical' }),
    ];
    const { sweep, sendNotification } = makeSweep({ findExpiredRows: rows });

    const result = await sweep.tick();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    const payload = sendNotification.mock.calls[0]![0];
    expect(payload.notificationType).toBe('approval_expired');
    expect(payload.ceoEmail).toBe('principal@example.com');
    expect(payload.subject).toContain('2 request(s)');
    expect(payload.body).toContain('high-ref');
    expect(payload.body).toContain('crit-ref');
    expect(payload.body).not.toContain('low-ref');
    expect(result).toEqual({ expired: 3, notified: 2 });
  });

  it('reads the principal email at tick time, so a post-boot bind takes effect', async () => {
    const rows = [makeRow({ id: 1, shortRef: 'high-ref', actionRisk: 'high' })];
    const { sweep, sendNotification, principalEmail } = makeSweep({ findExpiredRows: rows, ceoEmail: '' });

    // Bound after construction — the live ref is what the sweep must read.
    principalEmail.current = 'bound-later@example.com';
    await sweep.tick();

    expect(sendNotification.mock.calls[0]![0].ceoEmail).toBe('bound-later@example.com');
  });

  it('only notifies about rows that actually expired (concurrent resolution)', async () => {
    const highRow = makeRow({ id: 1, shortRef: 'high-ref', actionRisk: 'high' });
    const critRow = makeRow({ id: 2, shortRef: 'crit-ref', actionRisk: 'critical' });
    const { sweep, sendNotification, logger } = makeSweep({
      findExpiredRows: [highRow, critRow],
      expireRowsResult: [highRow], // the critical row was resolved before the UPDATE ran
    });

    const result = await sweep.tick();

    expect(logger.warn).toHaveBeenCalled();
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const payload = sendNotification.mock.calls[0]![0];
    expect(payload.subject).toContain('1 request(s)');
    expect(payload.body).not.toContain('crit-ref');
    expect(result).toEqual({ expired: 1, notified: 1 });
  });

  it('still expires but skips the notification when no principal email is on file', async () => {
    const rows = [makeRow({ id: 1, shortRef: 'high-ref', actionRisk: 'high' })];
    const { sweep, expireRows, sendNotification, logger } = makeSweep({ findExpiredRows: rows, ceoEmail: '' });

    const result = await sweep.tick();

    expect(expireRows).toHaveBeenCalledWith([1]);
    expect(sendNotification).not.toHaveBeenCalled();
    // Expired rows are never retried, so the skip log must name them for manual follow-up.
    expect(logger.warn).toHaveBeenCalledWith(
      { notifiableCount: 1, ids: [1], shortRefs: ['high-ref'] },
      expect.stringContaining('no principal email'),
    );
    expect(result).toEqual({ expired: 1, notified: 0 });
  });

  it('still expires but skips the notification when the outbound gateway is absent', async () => {
    const rows = [makeRow({ id: 1, shortRef: 'high-ref', actionRisk: 'high' })];
    const { sweep, expireRows, logger } = makeSweep({ findExpiredRows: rows, withoutOutboundGateway: true });

    const result = await sweep.tick();

    expect(expireRows).toHaveBeenCalledWith([1]);
    expect(logger.warn).toHaveBeenCalled();
    expect(result).toEqual({ expired: 1, notified: 0 });
  });

  it('reports notified:0 when sendNotification returns false', async () => {
    const rows = [makeRow({ id: 1, shortRef: 'crit-ref', actionRisk: 'critical' })];
    const { sweep, logger } = makeSweep({ findExpiredRows: rows, sendNotificationResult: false });

    const result = await sweep.tick();

    expect(logger.warn).toHaveBeenCalled();
    expect(result).toEqual({ expired: 1, notified: 0 });
  });

  it('rejects when the repository call throws, without notifying', async () => {
    const { sweep, findExpired, sendNotification } = makeSweep();
    findExpired.mockRejectedValue(new Error('DB down'));

    await expect(sweep.tick()).rejects.toThrow('DB down');
    expect(sendNotification).not.toHaveBeenCalled();
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
