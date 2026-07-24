import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { DbAvailabilityMonitor } from '../../../src/db/availability-monitor.js';
import type { Logger } from '../../../src/logger.js';
import type { OutboundGateway } from '../../../src/skills/outbound-gateway.js';

function createLogger(): Logger {
  return {
    child: () => createLogger(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: 'info',
  } as unknown as Logger;
}

describe('DbAvailabilityMonitor', () => {
  let now: number;
  let timers: Array<{ cb: () => void; ms: number }>;

  beforeEach(() => {
    now = 1_000_000;
    timers = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createMonitor(overrides: {
    queryImpl?: () => Promise<unknown>;
    sendNotification?: ReturnType<typeof vi.fn>;
    escalationAfterMs?: number;
  } = {}) {
    const sendNotification =
      overrides.sendNotification ?? vi.fn().mockResolvedValue(true);
    const pool = {
      query: overrides.queryImpl ?? vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    } as unknown as Pool;
    const gateway = { sendNotification } as unknown as OutboundGateway;

    const monitor = new DbAvailabilityMonitor({
      pool,
      logger: createLogger(),
      outboundGateway: gateway,
      ceoEmail: 'ceo@example.com',
      probeIntervalMs: 60_000,
      escalationAfterMs: overrides.escalationAfterMs ?? 5 * 60_000,
      now: () => now,
      setIntervalFn: ((cb: () => void, ms: number) => {
        timers.push({ cb, ms });
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearIntervalFn: vi.fn() as unknown as typeof clearInterval,
    });

    return { monitor, pool, sendNotification };
  }

  it('stays available when probe succeeds', async () => {
    const { monitor } = createMonitor();
    const snap = await monitor.probe();
    expect(snap.available).toBe(true);
    expect(snap.downSince).toBeNull();
    expect(snap.escalationDue).toBe(false);
  });

  it('marks unavailable on probe failure without escalating immediately', async () => {
    const { monitor, sendNotification } = createMonitor({
      queryImpl: () =>
        Promise.reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })),
    });
    const snap = await monitor.probe();
    expect(snap.available).toBe(false);
    expect(snap.downSince).toBe(now);
    expect(snap.escalationDue).toBe(false);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('escalates to CEO after continuous outage exceeds threshold', async () => {
    const sendNotification = vi.fn().mockResolvedValue(true);
    const { monitor } = createMonitor({
      queryImpl: () =>
        Promise.reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })),
      sendNotification,
      escalationAfterMs: 5 * 60_000,
    });

    await monitor.probe();
    expect(monitor.getSnapshot().escalationDue).toBe(false);

    now += 5 * 60_000 + 1;
    const snap = await monitor.probe();
    expect(snap.escalationDue).toBe(true);
    expect(snap.escalated).toBe(true);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification.mock.calls[0]![0]).toMatchObject({
      notificationType: 'database_unavailable',
      ceoEmail: 'ceo@example.com',
    });
  });

  it('retries notification when send fails, then succeeds once', async () => {
    const sendNotification = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const { monitor } = createMonitor({
      queryImpl: () =>
        Promise.reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })),
      sendNotification,
      escalationAfterMs: 1_000,
    });

    await monitor.probe();
    now += 2_000;
    await monitor.probe();
    expect(monitor.getSnapshot().escalated).toBe(false);
    expect(sendNotification).toHaveBeenCalledTimes(1);

    now += 2_000;
    await monitor.probe();
    expect(monitor.getSnapshot().escalated).toBe(true);
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it('notifies on recovery if escalation was due but undelivered', async () => {
    const sendNotification = vi
      .fn()
      .mockResolvedValueOnce(false) // while down
      .mockResolvedValueOnce(true); // on recovery
    let down = true;
    const { monitor } = createMonitor({
      queryImpl: () =>
        down
          ? Promise.reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))
          : Promise.resolve({ rows: [] }),
      sendNotification,
      escalationAfterMs: 1_000,
    });

    await monitor.probe();
    now += 2_000;
    await monitor.probe();
    expect(monitor.getSnapshot().escalated).toBe(false);

    down = false;
    now += 1_000;
    await monitor.probe();
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(monitor.getSnapshot().available).toBe(true);
  });
});
