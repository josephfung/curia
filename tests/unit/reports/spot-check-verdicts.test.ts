// spot-check-verdicts — resolving a principal's "2 bad" reply to the right digest's set (#2159).
import { describe, it, expect, vi } from 'vitest';
import {
  resolveSpotCheckSet,
  matchVerdicts,
} from '../../../src/reports/spot-check-verdicts.js';
import { SpotCheckStore, type SpotCheckSet } from '../../../src/reports/spot-check-store.js';
import { createSilentLogger } from '../../../src/logger.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const NO_MATCH = 'No spot check in the last 24 hours matches this reply. Ask the principal which action they mean; do not guess.';
const NO_SET_ON_THREAD = 'No spot check went out on this email thread. Ask the principal which action they mean; do not guess.';

function makeSet(over: Partial<SpotCheckSet> = {}): SpotCheckSet {
  return {
    id: 'set-1',
    createdAt: new Date(NOW - 5 * HOUR).toISOString(),
    conversationId: 'conv-1',
    items: [
      { n: 1, actionLogId: 101, summary: 'Replied to Dana about the Thursday slot.' },
      { n: 2, actionLogId: 102, summary: 'Archived an email from Sam.' },
      { n: 3, actionLogId: 103, summary: 'Declined a vendor call from Priya.' },
    ],
    deliveries: [],
    ...over,
  };
}

/**
 * A real SpotCheckStore over an in-memory config store holding `sets`, so the resolver is tested
 * against the store's actual lookup rules (bound deliveries only, the 24 hour window).
 */
function storeWith(sets: SpotCheckSet[]): SpotCheckStore {
  const value = JSON.stringify({ sets });
  const get = vi.fn(async () => value);
  const set = vi.fn(async () => ({ stored: true }));
  return new SpotCheckStore({ get, set }, createSilentLogger(), () => NOW);
}

const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe('resolveSpotCheckSet', () => {
  it('resolves an email reply against the set delivered on its thread, even when a newer set went elsewhere', async () => {
    const onThread = makeSet({
      id: 'thread-set',
      deliveries: [{ channel: 'email', messageId: 'm1', threadId: 'th1', at: at(30 * HOUR) }],
    });
    const newer = makeSet({
      id: 'newer-set',
      deliveries: [{ channel: 'signal', messageId: 's1', at: at(HOUR) }],
    });

    const result = await resolveSpotCheckSet(storeWith([onThread, newer]), { channelId: 'email', conversationId: 'email:th1' });

    // The thread match has no time limit: 30 hours old still resolves.
    expect(result).toEqual({ ok: true, set: expect.objectContaining({ id: 'thread-set' }) });
  });

  // The 24 hour fallback is for chat replies (spec 14). An email reply always lands on some
  // thread; if no digest went out on it, "2 bad" is about something else, not the latest digest.
  it.each([
    ['on a thread with no digest', 'email:unbound'],
    ['with no thread at all', 'conv-without-prefix'],
  ])('refuses an email reply %s, even when a set was delivered within 24 hours', async (_label, conversationId) => {
    const recent = makeSet({
      id: 'recent',
      deliveries: [{ channel: 'signal', messageId: 's1', at: at(HOUR) }],
    });

    const result = await resolveSpotCheckSet(storeWith([recent]), { channelId: 'email', conversationId });

    expect(result).toEqual({ ok: false, error: NO_SET_ON_THREAD });
  });

  it.each([
    ['a Signal reply', { channelId: 'signal', conversationId: 'signal:+15550100' }],
    ['a Slack reply', { channelId: 'slack', conversationId: 'slack:C1' }],
  ])('falls back to the latest delivered set within 24 hours for %s', async (_label, where) => {
    const older = makeSet({
      id: 'older',
      deliveries: [{ channel: 'email', messageId: 'm1', threadId: 'th1', at: at(20 * HOUR) }],
    });
    const latest = makeSet({
      id: 'latest',
      deliveries: [{ channel: 'signal', messageId: 's1', at: at(2 * HOUR) }],
    });

    const result = await resolveSpotCheckSet(storeWith([older, latest]), where);

    expect(result).toEqual({ ok: true, set: expect.objectContaining({ id: 'latest' }) });
  });

  // A weekly digest went out at 8am with its block bound; the 6pm daily drew a set but its block
  // was reformatted, so the delivery never bound. "2 bad" at 6:10pm most likely means the daily's
  // item 2, so resolving it against the weekly would grade an action the principal never meant.
  it('refuses a chat reply when a newer set was drawn after the latest delivery, even unbound', async () => {
    const weekly = makeSet({
      id: 'weekly',
      createdAt: at(10 * HOUR + 5 * 60_000),
      deliveries: [{ channel: 'signal', messageId: 's1', at: at(10 * HOUR) }],
    });
    const daily = makeSet({ id: 'daily', createdAt: at(10 * 60_000), deliveries: [] });

    const result = await resolveSpotCheckSet(storeWith([weekly, daily]), { channelId: 'signal', conversationId: 'signal:+15550100' });

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('Ask the principal which action they mean');
    expect((result as { error: string }).error).toContain('newer spot check');
  });

  it('still resolves a chat reply when the only other set was drawn before the latest delivery', async () => {
    const earlier = makeSet({ id: 'earlier', createdAt: at(20 * HOUR), deliveries: [] });
    const latest = makeSet({
      id: 'latest',
      createdAt: at(3 * HOUR),
      deliveries: [{ channel: 'signal', messageId: 's1', at: at(2 * HOUR) }],
    });

    const result = await resolveSpotCheckSet(storeWith([earlier, latest]), { channelId: 'signal', conversationId: 'signal:+15550100' });

    expect(result).toEqual({ ok: true, set: expect.objectContaining({ id: 'latest' }) });
  });

  it('fails when nothing was delivered within 24 hours, telling the coordinator to ask the principal', async () => {
    const stale = makeSet({
      deliveries: [{ channel: 'signal', messageId: 's1', at: at(25 * HOUR) }],
    });

    const result = await resolveSpotCheckSet(storeWith([stale]), { channelId: 'signal', conversationId: 'signal:+15550100' });

    expect(result).toEqual({ ok: false, error: NO_MATCH });
    expect((result as { error: string }).error).toContain('Ask the principal which action they mean');
  });

  // Review Focus 3: a digest whose block was dropped before delivery never showed these numbers.
  it('does not resolve a set that was stored but never delivered', async () => {
    const undelivered = makeSet({ createdAt: at(10 * 60_000), deliveries: [] });

    const viaFallback = await resolveSpotCheckSet(storeWith([undelivered]), { channelId: 'signal', conversationId: 'signal:+15550100' });
    const viaEmail = await resolveSpotCheckSet(storeWith([undelivered]), { channelId: 'email', conversationId: 'email:th1' });

    expect(viaFallback).toEqual({ ok: false, error: NO_MATCH });
    expect(viaEmail).toEqual({ ok: false, error: NO_SET_ON_THREAD });
  });

  it('propagates a store read error rather than reporting no match', async () => {
    const store = { findByEmailThread: vi.fn(), findLatestDelivered: vi.fn().mockRejectedValue(new Error('db down')), hasSetCreatedAfter: vi.fn() };

    await expect(resolveSpotCheckSet(store, { channelId: 'signal' })).rejects.toThrow('db down');
  });
});

describe('matchVerdicts', () => {
  it('matches each number to its item', () => {
    const set = makeSet();

    const result = matchVerdicts(set, [{ n: 2, verdict: 'bad', reason: 'that was a renewal notice' }]);

    expect(result).toEqual({
      ok: true,
      matched: [{ n: 2, verdict: 'bad', reason: 'that was a renewal notice', item: set.items[1]! }],
    });
  });

  it('fails the whole call on an unknown number, listing the valid numbers with their summaries', () => {
    const result = matchVerdicts(makeSet(), [
      { n: 2, verdict: 'bad', reason: 'that was a renewal notice' },
      { n: 5, verdict: 'good' },
    ]);

    expect(result.ok).toBe(false);
    const error = (result as { error: string }).error;
    expect(error).toContain('5');
    expect(error).toContain('1. Replied to Dana about the Thursday slot.');
    expect(error).toContain('2. Archived an email from Sam.');
    expect(error).toContain('3. Declined a vendor call from Priya.');
    expect(error).toContain('Ask the principal which action they mean');
  });

  it('fails when the same number is given two different verdicts', () => {
    const result = matchVerdicts(makeSet(), [
      { n: 2, verdict: 'bad' },
      { n: 2, verdict: 'good' },
    ]);

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/2/);
  });

  it('collapses the same number given twice with the same verdict to one match', () => {
    const result = matchVerdicts(makeSet(), [
      { n: 1, verdict: 'good' },
      { n: 1, verdict: 'good' },
    ]);

    expect(result.ok).toBe(true);
    expect((result as { matched: unknown[] }).matched).toHaveLength(1);
  });
});
