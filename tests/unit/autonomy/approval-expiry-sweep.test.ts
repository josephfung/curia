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
import { ApprovalDelivery, type DeliverResult } from '../../../src/autonomy/approval-delivery.js';
import type { OutboundGateway } from '../../../src/skills/outbound-gateway.js';
import type { ChannelIdentity, PrincipalEmailRef } from '../../../src/contacts/types.js';

const NOW = new Date('2026-10-18T12:00:00.000Z');
const DAY_MS = 86_400_000;
import type { BusEvent, PrincipalReportEvent } from '../../../src/bus/events.js';
import type { Logger } from '../../../src/logger.js';

// --- Fixtures ---

function makeRow(overrides: Partial<ActionLogRow> = {}): ActionLogRow {
  return {
    id: 1,
    shortRef: 'cal-1',
    approvalNumber: null,
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
  undeliveredRows?: ActionLogRow[];
  deliverResults?: DeliverResult[];
  availableChannels?: string[];
  withoutDelivery?: boolean;
} = {}) {
  const {
    findExpiredRows = [],
    expireRowsResult = findExpiredRows,
    failPublishFor = [],
    undeliveredRows = [],
    deliverResults = [],
    availableChannels = ['email'],
    withoutDelivery = false,
  } = overrides;

  const findExpired = vi.fn().mockResolvedValue(findExpiredRows);
  const findUndelivered = vi.fn().mockResolvedValue(undeliveredRows);
  const results = [...deliverResults];
  const deliver = vi.fn(async (_ref: string, channel: string) =>
    results.shift() ?? ({ delivered: true, channel } as DeliverResult));
  const approvalDelivery = { deliver, availableChannels: vi.fn().mockReturnValue(availableChannels) };
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
    actionLogRepo: { findExpired, expireRows, findUndelivered } as unknown as ActionLogRepo,
    bus: { publish } as unknown as EventBus,
    ...(withoutDelivery ? {} : { approvalDelivery: approvalDelivery as unknown as ApprovalDelivery }),
    logger: logger as unknown as Logger,
    intervalMinutes: 60,
    undeliveredAfterMinutes: 15,
    now: () => NOW,
  });

  return { sweep, findExpired, expireRows, findUndelivered, deliver, publish, published, logger };
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

    expect(result).toEqual({ expired: 0, notified: 0, safetyNetDelivered: 0 });
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
    expect(result).toEqual({ expired: 2, notified: 2, safetyNetDelivered: 0 });
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
    expect(result).toEqual({ expired: 1, notified: 1, safetyNetDelivered: 0 });
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
    expect(result).toEqual({ expired: 2, notified: 1, safetyNetDelivered: 0 });
  });

  it('rejects when the repository call throws, without queueing', async () => {
    const { sweep, findExpired, publish } = makeSweep();
    findExpired.mockRejectedValue(new Error('DB down'));

    await expect(sweep.tick()).rejects.toThrow('DB down');
    expect(publish).not.toHaveBeenCalled();
  });
});

// --- safety net (#2159) ---

describe('ApprovalExpirySweep safety net (#2159)', () => {
  it('emails an approval no agent delivered within 15 minutes, once, before expiring anything', async () => {
    const { sweep, findUndelivered, findExpired, deliver, logger } = makeSweep({
      undeliveredRows: [makeRow({ id: 9, shortRef: 'late-ref' })],
    });

    const result = await sweep.tick();

    expect(findUndelivered).toHaveBeenCalledWith(new Date(NOW.getTime() - 15 * 60_000));
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith('late-ref', 'email');
    // The safety net firing means an agent skipped its delivery: worth a warning.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ shortRef: 'late-ref' }),
      expect.stringContaining('safety net'),
    );
    expect(findUndelivered.mock.invocationCallOrder[0]!).toBeLessThan(findExpired.mock.invocationCallOrder[0]!);
    expect(result.safetyNetDelivered).toBe(1);
  });

  it('uses the first available channel when the principal has no email', async () => {
    const { sweep, deliver } = makeSweep({
      undeliveredRows: [makeRow({ id: 9, shortRef: 'late-ref' })],
      deliverResults: [{ delivered: false, reason: 'channel_unavailable', available: ['signal'] }],
      availableChannels: ['signal'],
    });

    await sweep.tick();

    expect(deliver.mock.calls.map((c) => c[1])).toEqual(['email', 'signal']);
  });

  it('logs at error when the safety net cannot deliver either, and tries again next tick', async () => {
    const { sweep, logger } = makeSweep({
      undeliveredRows: [makeRow({ id: 9, shortRef: 'late-ref' })],
      deliverResults: [{ delivered: false, reason: 'send_failed', available: [] }],
    });

    const result = await sweep.tick();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ shortRef: 'late-ref', reason: 'send_failed' }),
      expect.stringContaining('safety net'),
    );
    expect(result.safetyNetDelivered).toBe(0);
  });

  it('treats a row someone else delivered in the meantime as done, quietly', async () => {
    const { sweep, logger } = makeSweep({
      undeliveredRows: [makeRow({ id: 9, shortRef: 'late-ref' })],
      deliverResults: [{ delivered: false, reason: 'already_delivered', available: ['email'] }],
    });

    await sweep.tick();

    expect(logger.error).not.toHaveBeenCalled();
  });

  it('falls through to the next channel when email delivery fails', async () => {
    const { sweep, deliver } = makeSweep({
      undeliveredRows: [makeRow({ id: 9, shortRef: 'late-ref' })],
      deliverResults: [{ delivered: false, reason: 'send_failed', available: ['signal', 'sms'] }],
      availableChannels: ['signal', 'sms', 'email'],
    });

    const result = await sweep.tick();

    expect(deliver.mock.calls.map((c) => c[1])).toEqual(['email', 'signal']);
    expect(result.safetyNetDelivered).toBe(1);
  });

  // Review fix: ApprovalDelivery drops a channel that failed once from `available` for the
  // rest of the process. Building the fallback from that list retired the principal's only
  // channel after one transient outage, so the safety net never pinged them.
  it('retries a channel that failed earlier, with a real ApprovalDelivery', async () => {
    const row = makeRow({ id: 9, shortRef: 'late-ref', expiresAt: new Date(NOW.getTime() + DAY_MS) });
    const send = vi.fn()
      .mockResolvedValueOnce({ success: false, blockedReason: 'signal-cli down' })
      .mockResolvedValue({ success: true, messageId: 'sig-1' });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const delivery = new ApprovalDelivery({
      actionLogRepo: {
        findPendingByShortRef: vi.fn().mockResolvedValue(row),
        claimNotification: vi.fn().mockResolvedValue(true),
        releaseNotification: vi.fn().mockResolvedValue(undefined),
        bindDeliveryMessage: vi.fn().mockResolvedValue(true),
      } as unknown as ActionLogRepo,
      outboundGateway: { send } as unknown as OutboundGateway,
      // Signal only: no email on file.
      principalIdentities: [{
        id: 'id-signal', contactId: 'principal-1', channel: 'signal', channelIdentifier: '+15550001111', label: null,
        verified: true, verifiedAt: null, status: 'active', source: 'ceo_stated', createdAt: NOW, updatedAt: NOW,
      } as ChannelIdentity],
      principalEmail: { current: '' } as PrincipalEmailRef,
      logger: logger as unknown as Logger,
    });

    // The agent's attempt during the outage fails and marks Signal as failed.
    await expect(delivery.deliver('late-ref', 'signal')).resolves.toMatchObject({ delivered: false, reason: 'send_failed' });

    const sweep = new ApprovalExpirySweep({
      actionLogRepo: {
        findExpired: vi.fn().mockResolvedValue([]),
        expireRows: vi.fn().mockResolvedValue([]),
        findUndelivered: vi.fn().mockResolvedValue([row]),
      } as unknown as ActionLogRepo,
      bus: { publish: vi.fn() } as unknown as EventBus,
      approvalDelivery: delivery,
      logger: logger as unknown as Logger,
      intervalMinutes: 15,
      undeliveredAfterMinutes: 15,
      now: () => NOW,
    });

    const result = await sweep.tick();

    expect(result.safetyNetDelivered).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0]).toMatchObject({ channel: 'signal', recipient: '+15550001111' });
  });

  it('a failing row does not stop the other rows or the expiry pass', async () => {
    const { sweep, deliver, expireRows, logger } = makeSweep({
      undeliveredRows: [makeRow({ id: 1, shortRef: 'bad-ref' }), makeRow({ id: 2, shortRef: 'ok-ref' })],
      findExpiredRows: [makeRow({ id: 3, shortRef: 'old-ref' })],
    });
    deliver.mockImplementationOnce(async () => { throw new Error('db down'); });

    const result = await sweep.tick();

    expect(deliver.mock.calls.map((c) => c[0])).toEqual(['bad-ref', 'ok-ref']);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ shortRef: 'bad-ref' }), expect.stringContaining('safety net'));
    expect(expireRows).toHaveBeenCalledWith([3]);
    expect(result.safetyNetDelivered).toBe(1);
  });

  it('still expires rows when the safety-net lookup itself fails', async () => {
    const { sweep, findUndelivered, expireRows, logger } = makeSweep({ findExpiredRows: [makeRow({ id: 3 })] });
    findUndelivered.mockRejectedValue(new Error('db down'));

    await sweep.tick();

    expect(logger.error).toHaveBeenCalled();
    expect(expireRows).toHaveBeenCalledWith([3]);
  });

  it('logs a pending row with no reference instead of skipping it silently', async () => {
    const { sweep, deliver, logger } = makeSweep({ undeliveredRows: [makeRow({ id: 4, shortRef: null })] });

    await sweep.tick();

    expect(deliver).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ id: 4 }), expect.any(String));
  });

  it('skips the safety net without an approval delivery service', async () => {
    const { sweep, findUndelivered } = makeSweep({ withoutDelivery: true, undeliveredRows: [makeRow()] });

    await sweep.tick();

    expect(findUndelivered).not.toHaveBeenCalled();
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
      return { expired: 0, notified: 0, safetyNetDelivered: 0 };
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
