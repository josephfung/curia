// ReportFallbackDigest — the weekly summary for installs with no digest job (#2159).
import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';
import { ReportFallbackDigest } from '../../../src/reports/report-fallback-digest.js';
import { ReportQueue, type ReportBatch, type ReportItem } from '../../../src/reports/report-queue.js';
import type { AuditLogRow } from '../../../src/audit/audit-log-repo.js';
import { createSilentLogger } from '../../../src/logger.js';
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
  spotChecks?: { draw: Mock<(conversationId: string) => Promise<{ block: string; count: number } | null>> };
} = {}) {
  const batches = [...(opts.batches ?? [])];
  const queue = {
    oldestUnreported: vi.fn().mockResolvedValue(opts.oldest === undefined ? null : opts.oldest),
    list: vi.fn(async (_opts?: { limit?: number; after?: string }) => batches.shift() ?? { items: [], cursor: null, hasMore: false }),
    ack: vi.fn().mockResolvedValue(true),
  };
  const send = vi.fn().mockResolvedValue(
    opts.sendResult === false ? { success: false, blockedReason: 'secret-pattern' } : { success: true, messageId: 'm1' },
  );
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ceoEmail: PrincipalEmailRef = { current: opts.ceoEmail ?? 'principal@example.com' };
  const digest = new ReportFallbackDigest({
    queue,
    outboundGateway: opts.withoutGateway ? undefined : ({ send } as unknown as OutboundGateway),
    ceoEmail,
    logger: logger as unknown as Logger,
    maxAgeDays: 7,
    checkIntervalHours: 24,
    timezone: 'America/Toronto',
    now: () => NOW,
    ...(opts.spotChecks ? { spotChecks: opts.spotChecks } : {}),
  });
  return { digest, queue, send, logger };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ReportFallbackDigest.tick', () => {
  it('does nothing when no item is waiting', async () => {
    const { digest, queue, send } = makeDigest({ oldest: null });

    await expect(digest.tick()).resolves.toEqual({ sent: false, items: 0 });
    expect(queue.list).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('does nothing while the oldest item is under a week old — a digest job may still pick it up', async () => {
    const { digest, send } = makeDigest({ oldest: new Date(NOW.getTime() - 6 * DAY) });

    await expect(digest.tick()).resolves.toEqual({ sent: false, items: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('sends one numbered summary past a week, then acknowledges', async () => {
    const cursor = '{"t":"2026-10-10T12:00:00.000Z","id":"id-2"}';
    const { digest, queue, send } = makeDigest({
      oldest: new Date(NOW.getTime() - 8 * DAY),
      batches: [{ items: [item(1, 'Replied to Dana.'), item(2, 'Block notice.\nReason: secret-pattern')], cursor, hasMore: false }],
    });

    await expect(digest.tick()).resolves.toEqual({ sent: true, items: 2 });

    expect(send).toHaveBeenCalledTimes(1);
    const [payload, sendOpts] = send.mock.calls[0]!;
    expect(payload).toMatchObject({ channel: 'email', to: 'principal@example.com', subject: 'Curia: weekly summary' });
    // Delivered even below the send threshold; a blocked summary must not report itself.
    expect(sendOpts).toEqual({ isSystemNotification: true, skipNotificationOnBlock: true, conversationId: `report-fallback:${NOW.toISOString()}` });
    expect(payload.body).toMatch(/^1\. Replied to Dana\./m);
    expect(payload.body).toMatch(/^2\. Block notice\. \(Oct 10\)$/m);
    // A multi-line item stays under its number.
    expect(payload.body).toMatch(/^ {3}Reason: secret-pattern$/m);
    expect(queue.ack).toHaveBeenCalledWith(cursor);
  });

  it('reads every page before sending and acknowledges the last cursor', async () => {
    const { digest, queue, send } = makeDigest({
      oldest: new Date(NOW.getTime() - 8 * DAY),
      batches: [
        { items: [item(1, 'One.')], cursor: 'c1', hasMore: true },
        { items: [item(2, 'Two.')], cursor: 'c2', hasMore: false },
      ],
    });

    await expect(digest.tick()).resolves.toEqual({ sent: true, items: 2 });
    expect(send.mock.calls[0]![0].body).toMatch(/^2\. Two\./m);
    expect(queue.list.mock.calls.map((c) => c[0])).toEqual([{ limit: 100 }, { limit: 100, after: 'c1' }]);
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

  // One item the content filter will not pass (a third-party address while the contact
  // lookup is down, a secret-like string) must not leave the principal hearing nothing.
  it('sends an item-free notice when the content filter holds the summary, and keeps the items queued', async () => {
    const { digest, queue, send, logger } = makeDigest({
      oldest: new Date(NOW.getTime() - 8 * DAY),
      batches: [{ items: [item(1, 'One.'), item(2, 'Blocked send to dana@example.com.')], cursor: 'c1', hasMore: false }],
    });
    send
      .mockResolvedValueOnce({ success: false, blockedReason: 'held', blockedRules: ['contact-data-leak'] })
      .mockResolvedValueOnce({ success: true, messageId: 'm2' });

    await expect(digest.tick()).resolves.toEqual({ sent: false, items: 2, noticeSent: true });

    expect(send).toHaveBeenCalledTimes(2);
    const [notice, noticeOpts] = send.mock.calls[1]!;
    expect(notice).toMatchObject({ channel: 'email', to: 'principal@example.com', subject: 'Curia: weekly summary' });
    expect(notice.body).toContain('2 items');
    expect(notice.body).toContain('contact-data-leak');
    // No item text, so the notice cannot trip the rule that held the summary.
    expect(notice.body).not.toContain('One.');
    expect(notice.body).not.toContain('dana@example.com');
    expect(noticeOpts).toEqual({ isSystemNotification: true, skipNotificationOnBlock: true });
    // Not acknowledged: the items stay queued until a digest or the principal reads them.
    expect(queue.ack).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ blockedRules: ['contact-data-leak'] }), expect.any(String));
  });

  it('logs at error when the item-free notice is also not delivered', async () => {
    const { digest, queue, send, logger } = makeDigest({
      oldest: new Date(NOW.getTime() - 8 * DAY),
      batches: [{ items: [item(1, 'One.')], cursor: 'c1', hasMore: false }],
    });
    send
      .mockResolvedValueOnce({ success: false, blockedReason: 'held', blockedRules: ['secret-pattern'] })
      .mockResolvedValueOnce({ success: false, blockedReason: 'email down' });

    await expect(digest.tick()).resolves.toEqual({ sent: false, items: 1, noticeSent: false });
    expect(queue.ack).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('notice'));
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

describe('ReportFallbackDigest spot checks', () => {
  const cursor = 'c1';
  const waiting = () => ({
    oldest: new Date(NOW.getTime() - 8 * DAY),
    batches: [{ items: [item(1, 'Replied to Dana.')], cursor, hasMore: false }],
  });
  const block = 'Spot check (optional, reply with a number):\n1. Sent a reply to Priya\n2. Archived a newsletter';

  it('appends the block after a blank line and sends under the fallback conversation id', async () => {
    const draw = vi.fn<(conversationId: string) => Promise<{ block: string; count: number } | null>>().mockResolvedValue({ block, count: 2 });
    const { digest, send } = makeDigest({ ...waiting(), spotChecks: { draw } });

    await expect(digest.tick()).resolves.toEqual({ sent: true, items: 1 });

    const conversationId = `report-fallback:${NOW.toISOString()}`;
    expect(draw).toHaveBeenCalledWith(conversationId);
    const [payload, sendOpts] = send.mock.calls[0]!;
    expect(payload.body.endsWith(`\n\n${block}`)).toBe(true);
    // The binder matches the delivered event to the stored set by this id.
    expect(sendOpts).toEqual({ isSystemNotification: true, skipNotificationOnBlock: true, conversationId });
  });

  it('leaves the body unchanged when nothing was drawn', async () => {
    const draw = vi.fn<(conversationId: string) => Promise<{ block: string; count: number } | null>>().mockResolvedValue(null);
    const withDraw = makeDigest({ ...waiting(), spotChecks: { draw } });
    const without = makeDigest(waiting());

    await withDraw.digest.tick();
    await without.digest.tick();

    expect(withDraw.send.mock.calls[0]![0].body).toBe(without.send.mock.calls[0]![0].body);
    expect(withDraw.send.mock.calls[0]![0].body).not.toContain('Spot check');
  });

  it('sends the plain body with no spot-check dependency wired', async () => {
    const { digest, send } = makeDigest(waiting());

    await digest.tick();

    expect(send.mock.calls[0]![0].body).not.toContain('Spot check');
  });
});

describe('ReportFallbackDigest with a real ReportQueue', () => {
  // Pages through the real queue: a list() that ignored its cursor would repeat page one.
  it('sends every waiting item once across pages and acknowledges the last seq', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({
      seq: String(i + 1),
      row: {
        id: `id-${i + 1}`, timestamp: new Date(NOW.getTime() - 9 * DAY), eventType: 'principal.report', sourceLayer: 'system',
        sourceId: 'system', conversationId: null, taskId: null, parentEventId: 't', payload: { summary: `Item ${i + 1}`, urgency: 'digest', source: 'agent' },
        action: null, outcome: null, targetType: null, targetId: null, initiatorType: null, initiatorId: null, entryHash: null,
      } as AuditLogRow,
    }));
    const set = vi.fn().mockResolvedValue({ stored: true });
    const queue = new ReportQueue({
      auditLogRepo: {
        findByEventTypeAfterSeq: vi.fn(async (_t: string, after: string | null, limit: number) => {
          const start = after === null ? 0 : Number(after);
          return { rows: rows.slice(start, start + limit), hasMore: start + limit < rows.length };
        }),
        hasEventAtSeq: vi.fn(async (_t: string, seq: string) => Number(seq) >= 1 && Number(seq) <= rows.length),
      },
      configStore: { get: vi.fn().mockResolvedValue(null), set },
      logger: createSilentLogger(),
    });
    const send = vi.fn().mockResolvedValue({ success: true });
    const digest = new ReportFallbackDigest({
      queue,
      outboundGateway: { send } as unknown as OutboundGateway,
      ceoEmail: 'principal@example.com',
      logger: createSilentLogger(),
      maxAgeDays: 7,
      checkIntervalHours: 24,
      now: () => NOW,
    });

    await expect(digest.tick()).resolves.toEqual({ sent: true, items: 150 });
    const body = send.mock.calls[0]![0].body as string;
    expect(body.match(/^\d+\. Item 1 /gm)).toHaveLength(1);
    expect(body).toMatch(/^150\. Item 150 /m);
    expect(set).toHaveBeenCalledWith('reports', 'last_reported', '150');
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
