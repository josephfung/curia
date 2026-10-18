// ReportQueue — reads principal.report audit rows for the digest (#2159).
import { describe, it, expect, vi } from 'vitest';
import { ReportQueue, REPORT_SETTLE_MS } from '../../../src/reports/report-queue.js';
import type { AuditLogRow, EventTypesAuditQuery, TimelinePage } from '../../../src/audit/audit-log-repo.js';
import { createSilentLogger } from '../../../src/logger.js';

const NOW = new Date('2026-10-18T12:00:00.000Z');

function row(id: string, at: string, payload: Record<string, unknown>): AuditLogRow {
  return {
    id,
    timestamp: new Date(at),
    eventType: 'principal.report',
    sourceLayer: 'dispatch',
    sourceId: 'dispatch',
    conversationId: null,
    taskId: null,
    parentEventId: 'task-1',
    payload,
    action: 'report',
    outcome: 'success',
    targetType: 'principal',
    targetId: 'agent',
    initiatorType: 'system',
    initiatorId: 'agent',
    entryHash: null,
  };
}

function makeQueue(opts: {
  pages?: TimelinePage[];
  stored?: string | null;
  setResult?: { stored: boolean };
}) {
  const pages = [...(opts.pages ?? [{ rows: [], hasMore: false }])];
  const findByEventTypes = vi.fn(async (_types: string[], _q: EventTypesAuditQuery) => pages.shift() ?? { rows: [], hasMore: false });
  const get = vi.fn().mockResolvedValue(opts.stored ?? null);
  const set = vi.fn().mockResolvedValue(opts.setResult ?? { stored: true });
  const logger = createSilentLogger();
  const warn = vi.spyOn(logger, 'warn');
  const queue = new ReportQueue({
    auditLogRepo: { findByEventTypes },
    configStore: { get, set },
    logger,
    now: () => NOW,
  });
  return { queue, findByEventTypes, get, set, warn };
}

describe('ReportQueue.list', () => {
  it('reads everything up to the settle lag when nothing has been acknowledged', async () => {
    const { queue, findByEventTypes } = makeQueue({
      pages: [{
        rows: [
          row('a', '2026-10-18T09:00:00.000Z', { summary: 'Replied to Dana.', urgency: 'digest', source: 'agent', conversationId: 'email:t1' }),
          row('b', '2026-10-18T10:00:00.000Z', { summary: 'Approval expired.', urgency: 'digest', source: 'approval_expired', actionShortRef: 'abcd1234' }),
        ],
        hasMore: false,
      }],
    });

    const batch = await queue.list();

    const [types, query] = findByEventTypes.mock.calls[0]!;
    expect(types).toEqual(['principal.report']);
    expect(query.after).toBeUndefined();
    expect(query.to).toEqual(new Date(NOW.getTime() - REPORT_SETTLE_MS));
    expect(batch.items.map((i) => i.summary)).toEqual(['Replied to Dana.', 'Approval expired.']);
    expect(batch.items[0]!.conversationId).toBe('email:t1');
    expect(batch.items[1]!.actionShortRef).toBe('abcd1234');
    expect(JSON.parse(batch.cursor!)).toEqual({ t: '2026-10-18T10:00:00.000Z', id: 'b' });
    expect(batch.hasMore).toBe(false);
  });

  it('starts after the acknowledged marker', async () => {
    const { queue, findByEventTypes } = makeQueue({
      stored: JSON.stringify({ t: '2026-10-17T08:00:00.000Z', id: 'z' }),
    });

    const batch = await queue.list();

    expect(findByEventTypes.mock.calls[0]![1].after).toEqual({ timestamp: new Date('2026-10-17T08:00:00.000Z'), id: 'z' });
    expect(batch.items).toEqual([]);
    expect(batch.cursor).toBeNull();
  });

  it('never moves the marker — only ack does, after the digest is sent', async () => {
    const { queue, set } = makeQueue({
      pages: [{ rows: [row('a', '2026-10-18T09:00:00.000Z', { summary: 'x', urgency: 'digest', source: 'agent' })], hasMore: false }],
    });

    await queue.list();

    expect(set).not.toHaveBeenCalled();
  });

  it('skips a malformed row with a warning and still advances the cursor past it', async () => {
    const { queue, warn } = makeQueue({
      pages: [{
        rows: [
          row('a', '2026-10-18T09:00:00.000Z', { urgency: 'digest', source: 'agent' }),
          row('b', '2026-10-18T09:30:00.000Z', { summary: 'ok', urgency: 'bogus', source: 'agent' }),
        ],
        hasMore: false,
      }],
    });

    const batch = await queue.list();

    expect(batch.items).toHaveLength(1);
    // An unknown urgency falls back to digest rather than dropping the item.
    expect(batch.items[0]!.urgency).toBe('digest');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(batch.cursor!).id).toBe('b');
  });

  it('treats an unreadable stored marker as no marker, with a warning', async () => {
    const { queue, findByEventTypes, warn } = makeQueue({ stored: 'not json' });

    await queue.list();

    expect(findByEventTypes.mock.calls[0]![1].after).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe('ReportQueue.ack', () => {
  it('stores the cursor', async () => {
    const { queue, set } = makeQueue({});
    const cursor = JSON.stringify({ t: '2026-10-18T10:00:00.000Z', id: 'b' });

    await expect(queue.ack(cursor)).resolves.toBe(true);

    expect(set).toHaveBeenCalledWith('reports', 'last_reported', cursor);
  });

  it('returns false when the config store soft-rejects the write', async () => {
    const { queue } = makeQueue({ setResult: { stored: false } });

    await expect(queue.ack(JSON.stringify({ t: '2026-10-18T10:00:00.000Z', id: 'b' }))).resolves.toBe(false);
  });

  it('rejects a cursor it did not issue', async () => {
    const { queue, set } = makeQueue({});

    await expect(queue.ack('garbage')).rejects.toThrow('invalid report cursor');
    await expect(queue.ack(JSON.stringify({ t: 'yesterday', id: 'b' }))).rejects.toThrow('invalid report cursor');
    expect(set).not.toHaveBeenCalled();
  });
});

describe('ReportQueue.oldestUnreported', () => {
  it('returns the first unacknowledged item time', async () => {
    const { queue, findByEventTypes } = makeQueue({
      pages: [{ rows: [row('a', '2026-10-10T09:00:00.000Z', { summary: 'x', urgency: 'digest', source: 'agent' })], hasMore: true }],
    });

    await expect(queue.oldestUnreported()).resolves.toEqual(new Date('2026-10-10T09:00:00.000Z'));
    expect(findByEventTypes.mock.calls[0]![1].limit).toBe(1);
  });

  it('returns null when nothing is waiting', async () => {
    const { queue } = makeQueue({});

    await expect(queue.oldestUnreported()).resolves.toBeNull();
  });
});
