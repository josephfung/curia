// ReportFallbackDigest — the weekly summary for installs with no digest job (#2159).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ReportFallbackDigest } from '../../../src/reports/report-fallback-digest.js';
import type { ReportBatch, ReportItem } from '../../../src/reports/report-queue.js';
import type { OutboundGateway } from '../../../src/skills/outbound-gateway.js';
import type { PrincipalEmailRef } from '../../../src/contacts/types.js';
import type { Logger } from '../../../src/logger.js';

const NOW = new Date('2026-10-18T12:00:00.000Z');
const DAY = 86_400_000;

function item(n: number, summary: string, at = new Date(NOW.getTime() - 8 * DAY)): ReportItem {
  return { id: `id-${n}`, at, summary, urgency: 'digest', source: 'agent' };
}

function makeDigest(opts: {
  oldest?: Date | null;
  batches?: ReportBatch[];
  sendResult?: boolean;
  ceoEmail?: string;
  withoutGateway?: boolean;
} = {}) {
  const batches = [...(opts.batches ?? [])];
  const queue = {
    oldestUnreported: vi.fn().mockResolvedValue(opts.oldest === undefined ? null : opts.oldest),
    list: vi.fn(async () => batches.shift() ?? { items: [], cursor: null, hasMore: false }),
    ack: vi.fn().mockResolvedValue(true),
  };
  const sendNotification = vi.fn().mockResolvedValue(opts.sendResult ?? true);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ceoEmail: PrincipalEmailRef = { current: opts.ceoEmail ?? 'principal@example.com' };
  const digest = new ReportFallbackDigest({
    queue,
    outboundGateway: opts.withoutGateway ? undefined : ({ sendNotification } as unknown as OutboundGateway),
    ceoEmail,
    logger: logger as unknown as Logger,
    maxAgeDays: 7,
    checkIntervalHours: 24,
    timezone: 'America/Toronto',
    now: () => NOW,
  });
  return { digest, queue, sendNotification, logger };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ReportFallbackDigest.tick', () => {
  it('does nothing when no item is waiting', async () => {
    const { digest, queue, sendNotification } = makeDigest({ oldest: null });

    await expect(digest.tick()).resolves.toEqual({ sent: false, items: 0 });
    expect(queue.list).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('does nothing while the oldest item is under a week old — a digest job may still pick it up', async () => {
    const { digest, sendNotification } = makeDigest({ oldest: new Date(NOW.getTime() - 6 * DAY) });

    await expect(digest.tick()).resolves.toEqual({ sent: false, items: 0 });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('sends one numbered summary past a week, then acknowledges', async () => {
    const cursor = '{"t":"2026-10-10T12:00:00.000Z","id":"id-2"}';
    const { digest, queue, sendNotification } = makeDigest({
      oldest: new Date(NOW.getTime() - 8 * DAY),
      batches: [{ items: [item(1, 'Replied to Dana.'), item(2, 'Block notice.\nReason: secret-pattern')], cursor, hasMore: false }],
    });

    await expect(digest.tick()).resolves.toEqual({ sent: true, items: 2 });

    expect(sendNotification).toHaveBeenCalledTimes(1);
    const payload = sendNotification.mock.calls[0]![0];
    expect(payload.notificationType).toBe('report_digest');
    expect(payload.ceoEmail).toBe('principal@example.com');
    expect(payload.subject).toBe('Curia: weekly summary');
    expect(payload.body).toMatch(/^1\. Replied to Dana\./m);
    expect(payload.body).toMatch(/^2\. Block notice\. \(Oct 10\)$/m);
    // A multi-line item stays under its number.
    expect(payload.body).toMatch(/^ {3}Reason: secret-pattern$/m);
    expect(queue.ack).toHaveBeenCalledWith(cursor);
  });

  it('reads every page before sending and acknowledges the last cursor', async () => {
    const { digest, queue, sendNotification } = makeDigest({
      oldest: new Date(NOW.getTime() - 8 * DAY),
      batches: [
        { items: [item(1, 'One.')], cursor: 'c1', hasMore: true },
        { items: [item(2, 'Two.')], cursor: 'c2', hasMore: false },
      ],
    });

    await expect(digest.tick()).resolves.toEqual({ sent: true, items: 2 });
    expect(sendNotification.mock.calls[0]![0].body).toMatch(/^2\. Two\./m);
    expect(queue.ack).toHaveBeenCalledTimes(1);
    expect(queue.ack).toHaveBeenCalledWith('c2');
  });

  it('does not acknowledge when the send fails, and logs at error', async () => {
    const { digest, queue, logger } = makeDigest({
      oldest: new Date(NOW.getTime() - 8 * DAY),
      batches: [{ items: [item(1, 'One.')], cursor: 'c1', hasMore: false }],
      sendResult: false,
    });

    await expect(digest.tick()).resolves.toEqual({ sent: false, items: 1 });
    expect(queue.ack).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('logs at error when the send succeeded but the acknowledgement did not stick', async () => {
    const { digest, queue, logger } = makeDigest({
      oldest: new Date(NOW.getTime() - 8 * DAY),
      batches: [{ items: [item(1, 'One.')], cursor: 'c1', hasMore: false }],
    });
    queue.ack.mockResolvedValue(false);

    await expect(digest.tick()).resolves.toEqual({ sent: true, items: 1 });
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('will repeat'));
  });

  it('skips with a warning when no principal email is bound or no gateway exists', async () => {
    const noEmail = makeDigest({ oldest: new Date(NOW.getTime() - 8 * DAY), ceoEmail: '' });
    await expect(noEmail.digest.tick()).resolves.toEqual({ sent: false, items: 0 });
    expect(noEmail.logger.warn).toHaveBeenCalled();

    const noGateway = makeDigest({ oldest: new Date(NOW.getTime() - 8 * DAY), withoutGateway: true });
    await expect(noGateway.digest.tick()).resolves.toEqual({ sent: false, items: 0 });
    expect(noGateway.logger.warn).toHaveBeenCalled();
  });
});

describe('ReportFallbackDigest interval', () => {
  it('checks shortly after boot, then on the configured interval, and stops cleanly', async () => {
    vi.useFakeTimers();
    const { digest, queue } = makeDigest({ oldest: null });

    digest.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queue.oldestUnreported).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(queue.oldestUnreported).toHaveBeenCalledTimes(2);

    digest.stop();
    await vi.advanceTimersByTimeAsync(48 * 3_600_000);
    expect(queue.oldestUnreported).toHaveBeenCalledTimes(2);
  });

  it('logs a failing check at error and keeps running', async () => {
    vi.useFakeTimers();
    const { digest, queue, logger } = makeDigest();
    queue.oldestUnreported.mockRejectedValueOnce(new Error('db down'));

    digest.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(logger.error).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(queue.oldestUnreported).toHaveBeenCalledTimes(2);
    digest.stop();
  });
});
