// ReportQueue — reads principal.report audit rows for the digest (#2159).
import { describe, it, expect, vi } from 'vitest';
import { ReportQueue, InvalidReportCursorError } from '../../../src/reports/report-queue.js';
import type { AuditLogRow, SeqPage } from '../../../src/audit/audit-log-repo.js';
import { createSilentLogger } from '../../../src/logger.js';

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
  pages?: SeqPage[];
  stored?: string | null;
  setResult?: { stored: boolean };
  existingSeqs?: string[];
}) {
  const pages = [...(opts.pages ?? [{ rows: [], hasMore: false }])];
  const findByEventTypeAfterSeq = vi.fn(async (_type: string, _after: string | null, _limit: number) =>
    pages.shift() ?? { rows: [], hasMore: false });
  const hasEventAtSeq = vi.fn(async (_type: string, seq: string) => (opts.existingSeqs ?? []).includes(seq));
  const get = vi.fn().mockResolvedValue(opts.stored ?? null);
  const set = vi.fn().mockResolvedValue(opts.setResult ?? { stored: true });
  const logger = createSilentLogger();
  const warn = vi.spyOn(logger, 'warn');
  const queue = new ReportQueue({
    auditLogRepo: { findByEventTypeAfterSeq, hasEventAtSeq },
    configStore: { get, set },
    logger,
  });
  return { queue, findByEventTypeAfterSeq, hasEventAtSeq, get, set, warn };
}

describe('ReportQueue.list', () => {
  it('reads from the start when nothing has been acknowledged', async () => {
    const { queue, findByEventTypeAfterSeq } = makeQueue({
      pages: [{
        rows: [
          { seq: '11', row: row('a', '2026-10-18T09:00:00.000Z', { summary: 'Replied to Dana.', urgency: 'digest', source: 'agent', conversationId: 'email:t1' }) },
          { seq: '14', row: row('b', '2026-10-18T10:00:00.000Z', { summary: 'Approval expired.', urgency: 'digest', source: 'approval_expired', actionShortRef: 'abcd1234' }) },
        ],
        hasMore: false,
      }],
    });

    const batch = await queue.list();

    expect(findByEventTypeAfterSeq).toHaveBeenCalledWith('principal.report', null, 100);
    expect(batch.items.map((i) => i.summary)).toEqual(['Replied to Dana.', 'Approval expired.']);
    expect(batch.items[0]!.conversationId).toBe('email:t1');
    expect(batch.items[1]!.actionShortRef).toBe('abcd1234');
    expect(batch.cursor).toBe('14');
    expect(batch.hasMore).toBe(false);
  });

  it('lists items from the band-gating sources (#2159)', async () => {
    const { queue, warn } = makeQueue({
      pages: [{
        rows: [
          { seq: '20', row: row('c', '2026-10-18T11:00:00.000Z', { summary: 'Went ahead.', urgency: 'digest', source: 'gate_proceeded' }) },
          { seq: '21', row: row('d', '2026-10-18T11:01:00.000Z', { summary: 'Sent unreviewed.', urgency: 'digest', source: 'sent_without_review' }) },
          { seq: '22', row: row('e', '2026-10-18T11:02:00.000Z', { summary: 'Removed 1.', urgency: 'digest', source: 'claim_trimmed' }) },
        ],
        hasMore: false,
      }],
    });

    const batch = await queue.list();

    expect(batch.items.map((i) => i.source)).toEqual(['gate_proceeded', 'sent_without_review', 'claim_trimmed']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps an item with an unknown source as an agent item, with a warning', async () => {
    const { queue, warn } = makeQueue({
      pages: [{ rows: [{ seq: '30', row: row('f', '2026-10-18T12:00:00.000Z', { summary: 'From a newer build.', urgency: 'digest', source: 'future_source' }) }], hasMore: false }],
    });

    const batch = await queue.list();

    expect(batch.items.map((i) => [i.summary, i.source])).toEqual([['From a newer build.', 'agent']]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ source: 'future_source' }), expect.any(String));
  });

  it('starts after the acknowledged marker', async () => {
    const { queue, findByEventTypeAfterSeq } = makeQueue({ stored: '42' });

    const batch = await queue.list();

    expect(findByEventTypeAfterSeq).toHaveBeenCalledWith('principal.report', '42', 100);
    expect(batch.items).toEqual([]);
    expect(batch.cursor).toBeNull();
  });

  it('pages from an earlier batch cursor, not from the marker', async () => {
    const { queue, findByEventTypeAfterSeq, get } = makeQueue({ stored: '42' });

    await queue.list({ after: '57', limit: 10 });

    expect(findByEventTypeAfterSeq).toHaveBeenCalledWith('principal.report', '57', 10);
    expect(get).not.toHaveBeenCalled();
  });

  it('never moves the marker — only ack does, after the digest is sent', async () => {
    const { queue, set } = makeQueue({
      pages: [{ rows: [{ seq: '1', row: row('a', '2026-10-18T09:00:00.000Z', { summary: 'x', urgency: 'digest', source: 'agent' }) }], hasMore: false }],
    });

    await queue.list();

    expect(set).not.toHaveBeenCalled();
  });

  it('skips a malformed row with a warning and still advances the cursor past it', async () => {
    const { queue, warn } = makeQueue({
      pages: [{
        rows: [
          { seq: '1', row: row('a', '2026-10-18T09:00:00.000Z', { urgency: 'digest', source: 'agent' }) },
          { seq: '2', row: row('b', '2026-10-18T09:30:00.000Z', { summary: 'ok', urgency: 'bogus', source: 'agent' }) },
        ],
        hasMore: false,
      }],
    });

    const batch = await queue.list();

    expect(batch.items).toHaveLength(1);
    // An unknown urgency falls back to digest rather than dropping the item.
    expect(batch.items[0]!.urgency).toBe('digest');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(batch.cursor).toBe('2');
  });

  it('treats an unreadable stored marker as no marker, with a warning', async () => {
    const { queue, findByEventTypeAfterSeq, warn } = makeQueue({ stored: 'not a seq' });

    await queue.list();

    expect(findByEventTypeAfterSeq.mock.calls[0]![1]).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe('ReportQueue.ack', () => {
  it('stores a cursor that names a real report row', async () => {
    const { queue, set } = makeQueue({ existingSeqs: ['14'] });

    await expect(queue.ack('14')).resolves.toBe(true);

    expect(set).toHaveBeenCalledWith('reports', 'last_reported', '14');
  });

  it('returns false when the config store soft-rejects the write', async () => {
    const { queue } = makeQueue({ existingSeqs: ['14'], setResult: { stored: false } });

    await expect(queue.ack('14')).resolves.toBe(false);
  });

  it('rejects a cursor it did not issue — malformed, or naming no report row', async () => {
    const { queue, set } = makeQueue({ existingSeqs: ['14'] });

    await expect(queue.ack('garbage')).rejects.toBeInstanceOf(InvalidReportCursorError);
    // An invented cursor ahead of the queue would silently skip every waiting item.
    await expect(queue.ack('999999')).rejects.toBeInstanceOf(InvalidReportCursorError);
    expect(set).not.toHaveBeenCalled();
  });
});

describe('ReportQueue.oldestUnreported', () => {
  it('returns the first unacknowledged item time', async () => {
    const { queue, findByEventTypeAfterSeq } = makeQueue({
      stored: '5',
      pages: [{ rows: [{ seq: '6', row: row('a', '2026-10-10T09:00:00.000Z', { summary: 'x', urgency: 'digest', source: 'agent' }) }], hasMore: true }],
    });

    await expect(queue.oldestUnreported()).resolves.toEqual(new Date('2026-10-10T09:00:00.000Z'));
    expect(findByEventTypeAfterSeq).toHaveBeenCalledWith('principal.report', '5', 1);
  });

  it('returns null when nothing is waiting', async () => {
    const { queue } = makeQueue({});

    await expect(queue.oldestUnreported()).resolves.toBeNull();
  });
});
