// SpotCheckSampler — draws the digest's numbered spot-check block (#2159 Phase 3).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SpotCheckSampler, SPOT_CHECK_HEADER } from '../../../src/reports/spot-check-sampler.js';
import type { SpotCheckSet } from '../../../src/reports/spot-check-store.js';
import type { ActionLogRow } from '../../../src/autonomy/action-log-types.js';
import { createSilentLogger } from '../../../src/logger.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-19T12:00:00.000Z');

function row(id: number, over: Partial<ActionLogRow> = {}): ActionLogRow {
  return {
    id, taskId: `task-${id}`, conversationId: null, toolName: 'email-send', actionRisk: 'medium',
    outcome: 'success', taskSummary: null, competenceFlag: null, commitmentFlag: null, compatibility: null,
    scoredBy: 'sample-pool', payload: { sample: { signals: {} } }, notificationSentAt: null, resolvedAt: null,
    resolvedBy: null, expiresAt: null, parentActionId: null, shortRef: null,
    description: `Emailed dana@example.com: "Action ${id}"`, createdAt: new Date(NOW - id * 60_000),
    ...over,
  };
}

function makeDeps(opts: {
  rows?: ActionLogRow[];
  addResult?: boolean;
  findError?: Error;
  describeEmail?: (messageId: string, account?: string) => Promise<{ subject?: string; from?: string } | null>;
} = {}) {
  const logger = createSilentLogger();
  const warn = vi.spyOn(logger, 'warn');
  const error = vi.spyOn(logger, 'error');
  const findSampleCandidates = vi.fn(async () => {
    if (opts.findError) throw opts.findError;
    return opts.rows ?? [];
  });
  // markSampled is on the fake only to prove draw() never calls it: rows are marked when the
  // digest is delivered and bound (SpotCheckBinder), not when it is drawn.
  const markSampled = vi.fn(async (ids: readonly number[]) => ids.length);
  const actionLogRepo = { findSampleCandidates, markSampled };
  const add = vi.fn(async (_set: SpotCheckSet) => opts.addResult ?? true);
  const sampler = new SpotCheckSampler({
    actionLogRepo,
    store: { add },
    logger,
    // 0 always picks the first remaining candidate, so the draw order is the row order.
    random: () => 0,
    now: () => NOW,
    ...(opts.describeEmail ? { describeEmail: opts.describeEmail } : {}),
  });
  return { sampler, findSampleCandidates, markSampled, add, warn, error };
}

function triageRow(id: number, input: Record<string, unknown>, toolName = 'email-archive'): ActionLogRow {
  return row(id, {
    toolName, actionRisk: 'low', description: 'Archive an email',
    payload: { sample: { signals: { triage: true }, input } },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SpotCheckSampler.draw', () => {
  it('numbers up to three picks and stores their map, without marking them sampled', async () => {
    const { sampler, add, markSampled } = makeDeps({ rows: [row(1), row(2), row(3), row(4), row(5)] });

    const drawn = await sampler.draw('scheduler:job1:run1');

    expect(drawn).not.toBeNull();
    expect(drawn!.count).toBe(3);
    expect(drawn!.block.split('\n')).toEqual([
      SPOT_CHECK_HEADER,
      '1. Emailed dana@example.com: "Action 1"',
      '2. Emailed dana@example.com: "Action 2"',
      '3. Emailed dana@example.com: "Action 3"',
    ]);
    expect(SPOT_CHECK_HEADER).toBe('Spot check (optional, reply with a number):');

    expect(add).toHaveBeenCalledTimes(1);
    const set = add.mock.calls[0]![0];
    expect(set.conversationId).toBe('scheduler:job1:run1');
    expect(set.items.map((i) => [i.n, i.actionLogId])).toEqual([[1, 1], [2, 2], [3, 3]]);
    expect(set.deliveries).toEqual([]);
    expect(set.createdAt).toBe(new Date(NOW).toISOString());
    expect(typeof set.id).toBe('string');

    // A drawn digest may never be delivered (quiet-day debrief, failed send, block dropped by
    // the agent). The rows stay in the pool until the binder sees the digest delivered.
    expect(markSampled).not.toHaveBeenCalled();
  });

  it('returns null and stores or marks nothing when there are no candidates', async () => {
    const { sampler, add, markSampled } = makeDeps({ rows: [] });

    expect(await sampler.draw('conv-1')).toBeNull();
    expect(add).not.toHaveBeenCalled();
    expect(markSampled).not.toHaveBeenCalled();
  });

  it('returns null and does not mark when the store soft-rejects the map', async () => {
    const { sampler, markSampled, warn } = makeDeps({ rows: [row(1)], addResult: false });

    expect(await sampler.draw('conv-1')).toBeNull();
    // Unmarked rows stay in the pool for the next digest; numbers that cannot be resolved are not shown.
    expect(markSampled).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('returns null with an error logged when the candidate read throws', async () => {
    const { sampler, add, error } = makeDeps({ findError: new Error('db down') });

    expect(await sampler.draw('conv-1')).toBeNull();
    expect(add).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it('renders a multi-line summary on one line', async () => {
    const { sampler } = makeDeps({ rows: [row(1, { description: 'Emailed sam@example.com:\n"Re: Lunch"\r\n  thanks' })] });

    const drawn = await sampler.draw('conv-1');

    expect(drawn!.block.split('\n')).toEqual([SPOT_CHECK_HEADER, '1. Emailed sam@example.com: "Re: Lunch" thanks']);
  });

  it('falls back to the tool name when a row has no description', async () => {
    const { sampler } = makeDeps({ rows: [row(1, { toolName: 'calendar-create-event', description: null })] });

    const drawn = await sampler.draw('conv-1');

    expect(drawn!.block.split('\n')[1]).toBe('1. calendar-create-event');
  });

  it('reads candidates from the last 7 days', async () => {
    const { sampler, findSampleCandidates } = makeDeps({ rows: [] });

    await sampler.draw('conv-1');

    expect(findSampleCandidates).toHaveBeenCalledWith(new Date(NOW - 7 * DAY), 200);
  });

  it('weights a high-signal row above a malformed-payload row', async () => {
    // random 0.5 of a total weight of 4 (1 + 3) lands at 2, past the first row's weight of 1,
    // so the high-signal second row is picked first. A malformed payload weighs 1, never 0.
    const logger = createSilentLogger();
    const add = vi.fn(async (_set: SpotCheckSet) => true);
    const sampler = new SpotCheckSampler({
      actionLogRepo: {
        findSampleCandidates: vi.fn(async () => [
          row(1, { payload: { sample: 'not an object' } }),
          row(2, { payload: { sample: { signals: { firstContact: true } } } }),
        ]),
      },
      store: { add },
      logger,
      random: () => 0.5,
      now: () => NOW,
    });

    await sampler.draw('conv-1');

    expect(add.mock.calls[0]![0].items.map((i) => i.actionLogId)).toEqual([2, 1]);
  });

  describe('triage enrichment', () => {
    it('adds the subject and sender to a triage summary', async () => {
      const describeEmail = vi.fn(async () => ({ subject: 'Q4 board deck', from: 'Priya Shah (priya@example.com)' }));
      const { sampler, add } = makeDeps({
        rows: [triageRow(1, { message_id: 'msg-1', account: 'work' })],
        describeEmail,
      });

      const drawn = await sampler.draw('conv-1');

      expect(describeEmail).toHaveBeenCalledWith('msg-1', 'work');
      const line = 'Archive an email: "Q4 board deck" from Priya Shah (priya@example.com)';
      expect(drawn!.block.split('\n')[1]).toBe(`1. ${line}`);
      // The stored map carries the same summary the principal saw.
      expect(add.mock.calls[0]![0].items[0]!.summary).toBe(line);
    });

    it('drops a missing part and passes no account when the input has none', async () => {
      const describeEmail = vi.fn(async () => ({ subject: 'Weekly newsletter' }));
      const { sampler } = makeDeps({ rows: [triageRow(1, { message_id: 'msg-1' }, 'ceo-inbox-archive')], describeEmail });

      const drawn = await sampler.draw('conv-1');

      expect(describeEmail).toHaveBeenCalledWith('msg-1', undefined);
      expect(drawn!.block.split('\n')[1]).toBe('1. Archive an email: "Weekly newsletter"');
    });

    it('collapses an enriched summary to one line and caps its length', async () => {
      const longSubject = `Re:\n${'very long subject '.repeat(20)}`;
      const describeEmail = vi.fn(async () => ({ subject: longSubject, from: 'sam@example.com' }));
      const { sampler } = makeDeps({ rows: [triageRow(1, { message_id: 'msg-1' })], describeEmail });

      const drawn = await sampler.draw('conv-1');

      const line = drawn!.block.split('\n')[1]!;
      expect(line.startsWith('1. Archive an email: "Re: very long subject')).toBe(true);
      expect(line.length).toBeLessThanOrEqual('1. '.length + 120);
      expect(line.endsWith('…')).toBe(true);
    });

    it('keeps the stored summary, with a warning, when the lookup throws', async () => {
      const describeEmail = vi.fn(async () => { throw new Error('nylas 404'); });
      const { sampler, add, markSampled, warn } = makeDeps({ rows: [triageRow(1, { message_id: 'msg-1' }), row(2)], describeEmail });

      const drawn = await sampler.draw('conv-1');

      expect(drawn!.count).toBe(2);
      expect(drawn!.block.split('\n')[1]).toBe('1. Archive an email');
      expect(warn).toHaveBeenCalled();
      expect(add).toHaveBeenCalledTimes(1);
      expect(add.mock.calls[0]![0].items.map((i) => i.actionLogId)).toEqual([1, 2]);
      expect(markSampled).not.toHaveBeenCalled();
    });

    it('keeps the stored summary, with a warning, when the lookup returns null', async () => {
      const describeEmail = vi.fn(async () => null);
      const { sampler, warn } = makeDeps({ rows: [triageRow(1, { message_id: 'msg-1' })], describeEmail });

      const drawn = await sampler.draw('conv-1');

      expect(drawn!.block.split('\n')[1]).toBe('1. Archive an email');
      expect(warn).toHaveBeenCalled();
    });

    it('gives up on a lookup that takes longer than its timeout', async () => {
      vi.useFakeTimers();
      const describeEmail = vi.fn(() => new Promise<{ subject?: string; from?: string } | null>(() => {}));
      const { sampler, warn } = makeDeps({ rows: [triageRow(1, { message_id: 'msg-1' })], describeEmail });

      const pending = sampler.draw('conv-1');
      await vi.advanceTimersByTimeAsync(3_000);
      const drawn = await pending;

      expect(drawn!.block.split('\n')[1]).toBe('1. Archive an email');
      expect(warn).toHaveBeenCalled();
    });

    it('does not look up a row that already carries the email subject', async () => {
      const describeEmail = vi.fn(async () => ({ subject: 'should not be used' }));
      const stored = row(1, {
        toolName: 'ceo-inbox-archive', actionRisk: 'low',
        description: 'Archive an email: "Statement ready" from Billing (billing@example.com)',
        payload: { sample: { signals: { triage: true }, input: { message_id: 'msg-1' }, email: { subject: 'Statement ready', from: 'Billing (billing@example.com)' } } },
      });
      const { sampler, warn } = makeDeps({ rows: [stored], describeEmail });

      const drawn = await sampler.draw('conv-1');

      expect(describeEmail).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(drawn!.block.split('\n')[1]).toBe('1. Archive an email: "Statement ready" from Billing (billing@example.com)');
    });

    it('still looks up a triage row whose email has no subject', async () => {
      const describeEmail = vi.fn(async () => ({ subject: 'Looked up' }));
      const partial = row(1, {
        toolName: 'email-archive', actionRisk: 'low', description: 'Archive an email',
        payload: { sample: { signals: { triage: true }, input: { message_id: 'msg-1' }, email: { from: 'sam@example.com' } } },
      });
      const { sampler } = makeDeps({ rows: [partial], describeEmail });

      await sampler.draw('conv-1');

      expect(describeEmail).toHaveBeenCalledWith('msg-1', undefined);
    });

    it('never looks up a non-triage row, or a triage row without a message id', async () => {
      const describeEmail = vi.fn(async () => ({ subject: 'x' }));
      const { sampler } = makeDeps({
        rows: [
          row(1, { payload: { sample: { signals: {}, input: { message_id: 'msg-1' } } } }),
          triageRow(2, { labels: ['FYI'] }, 'email-label'),
        ],
        describeEmail,
      });

      const drawn = await sampler.draw('conv-1');

      expect(describeEmail).not.toHaveBeenCalled();
      expect(drawn!.count).toBe(2);
    });
  });
});
