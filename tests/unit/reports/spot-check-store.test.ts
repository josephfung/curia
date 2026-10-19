// SpotCheckStore — digest number-to-action maps kept in the config store (#2159).
import { describe, it, expect, vi } from 'vitest';
import {
  SpotCheckStore,
  SPOT_CHECK_NAMESPACE,
  SPOT_CHECK_KEY,
  type SpotCheckSet,
} from '../../../src/reports/spot-check-store.js';
import { createSilentLogger } from '../../../src/logger.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-19T12:00:00.000Z');

function makeSet(over: Partial<SpotCheckSet> = {}): SpotCheckSet {
  return {
    id: 'set-1',
    createdAt: new Date(NOW - 5 * 60_000).toISOString(),
    conversationId: 'conv-1',
    items: [
      { n: 1, actionLogId: 101, summary: 'Replied to Dana about the Thursday slot.' },
      { n: 2, actionLogId: 102, summary: 'Declined a vendor call from Sam.' },
    ],
    deliveries: [],
    ...over,
  };
}

/** In-memory config store fake: one value per (namespace, key), like report-queue's fake. */
function makeStore(opts: { stored?: string | null; setResult?: { stored: boolean }; getError?: Error } = {}) {
  const values = new Map<string, string>();
  if (opts.stored !== undefined && opts.stored !== null) {
    values.set(`${SPOT_CHECK_NAMESPACE}/${SPOT_CHECK_KEY}`, opts.stored);
  }
  const get = vi.fn(async (ns: string, key: string) => {
    if (opts.getError) throw opts.getError;
    return values.get(`${ns}/${key}`) ?? null;
  });
  const set = vi.fn(async (ns: string, key: string, value: string) => {
    const result = opts.setResult ?? { stored: true };
    if (result.stored) values.set(`${ns}/${key}`, value);
    return result;
  });
  const logger = createSilentLogger();
  const warn = vi.spyOn(logger, 'warn');
  const clock = { now: NOW };
  const store = new SpotCheckStore({ get, set }, logger, () => clock.now);
  const stored = (): { sets: SpotCheckSet[] } =>
    JSON.parse(values.get(`${SPOT_CHECK_NAMESPACE}/${SPOT_CHECK_KEY}`)!) as { sets: SpotCheckSet[] };
  return { store, get, set, warn, clock, stored };
}

describe('SpotCheckStore', () => {
  it('does not return a set as delivered until a delivery is bound', async () => {
    const { store } = makeStore();
    await expect(store.add(makeSet())).resolves.toBe(true);
    expect(await store.findLatestDelivered(DAY)).toBeNull();
  });

  it('finds a set by email thread and as the latest delivered once bound', async () => {
    const { store } = makeStore();
    const set = makeSet();
    await store.add(set);

    const at = new Date(NOW - 60_000).toISOString();
    await expect(
      store.bindDelivery(set.conversationId, { channel: 'email', messageId: 'm1', threadId: 'th1', at }),
    ).resolves.toBe(true);

    expect((await store.findByEmailThread('th1'))?.id).toBe('set-1');
    expect((await store.findLatestDelivered(DAY))?.id).toBe('set-1');
    expect(await store.findByEmailThread('other-thread')).toBeNull();
  });

  it('does not append the same messageId twice', async () => {
    const { store, stored } = makeStore();
    const set = makeSet();
    await store.add(set);
    const delivery = { channel: 'email', messageId: 'm1', threadId: 'th1', at: new Date(NOW).toISOString() };
    await store.bindDelivery(set.conversationId, delivery);
    await store.bindDelivery(set.conversationId, delivery);
    expect(stored().sets[0]!.deliveries).toHaveLength(1);
  });

  it('returns the set with the later delivery as latest, and each set by its own thread', async () => {
    const { store } = makeStore();
    await store.add(makeSet({ id: 'a', conversationId: 'conv-a' }));
    await store.add(makeSet({ id: 'b', conversationId: 'conv-b' }));
    await store.bindDelivery('conv-a', {
      channel: 'email', messageId: 'ma', threadId: 'th-a', at: new Date(NOW - 3 * HOUR).toISOString(),
    });
    await store.bindDelivery('conv-b', {
      channel: 'email', messageId: 'mb', threadId: 'th-b', at: new Date(NOW - 1 * HOUR).toISOString(),
    });

    expect((await store.findLatestDelivered(DAY))?.id).toBe('b');
    expect((await store.findByEmailThread('th-a'))?.id).toBe('a');
    expect((await store.findByEmailThread('th-b'))?.id).toBe('b');
  });

  it('ignores a delivery older than the window for latest, but still finds it by thread', async () => {
    const { store } = makeStore();
    await store.add(makeSet());
    await store.bindDelivery('conv-1', {
      channel: 'email', messageId: 'm1', threadId: 'th1', at: new Date(NOW - 25 * HOUR).toISOString(),
    });

    expect(await store.findLatestDelivered(DAY)).toBeNull();
    expect((await store.findByEmailThread('th1'))?.id).toBe('set-1');
  });

  it('prunes sets older than 14 days on the next add', async () => {
    const { store, stored } = makeStore();
    await store.add(makeSet({ id: 'old', createdAt: new Date(NOW - 15 * DAY).toISOString() }));
    await store.add(makeSet({ id: 'fresh', conversationId: 'conv-fresh' }));
    expect(stored().sets.map((s) => s.id)).toEqual(['fresh']);
  });

  it('keeps at most the newest 30 sets', async () => {
    const { store, stored } = makeStore();
    for (let i = 0; i < 32; i++) {
      await store.add(makeSet({
        id: `s${i}`,
        conversationId: `conv-${i}`,
        createdAt: new Date(NOW - (40 - i) * 60_000).toISOString(),
      }));
    }
    const ids = stored().sets.map((s) => s.id);
    expect(ids).toHaveLength(30);
    expect(ids[0]).toBe('s2');
    expect(ids[29]).toBe('s31');
  });

  it('treats malformed stored JSON as empty with a warning, and add starts a fresh list', async () => {
    const { store, warn, stored } = makeStore({ stored: '{not json' });
    expect(await store.findByEmailThread('th1')).toBeNull();
    expect(await store.findLatestDelivered(DAY)).toBeNull();
    expect(warn).toHaveBeenCalled();

    await expect(store.add(makeSet())).resolves.toBe(true);
    expect(stored().sets.map((s) => s.id)).toEqual(['set-1']);
  });

  it('drops malformed entries, keeps good ones, and warns', async () => {
    const good = makeSet({
      id: 'good',
      deliveries: [{ channel: 'email', messageId: 'm1', threadId: 'th1', at: new Date(NOW - HOUR).toISOString() }],
    });
    const raw = JSON.stringify({ sets: [null, { id: 'bad' }, { ...good, items: 'nope' }, good] });
    const { store, warn } = makeStore({ stored: raw });

    expect((await store.findByEmailThread('th1'))?.id).toBe('good');
    expect(warn).toHaveBeenCalled();
  });

  it('returns false from add when the config store soft-rejects the write', async () => {
    const { store } = makeStore({ setResult: { stored: false } });
    await expect(store.add(makeSet())).resolves.toBe(false);
  });

  it('returns false from bindDelivery for an unknown conversation and writes nothing', async () => {
    const { store, set } = makeStore();
    await store.add(makeSet());
    set.mockClear();

    await expect(
      store.bindDelivery('no-such-conversation', { channel: 'email', messageId: 'm1', at: new Date(NOW).toISOString() }),
    ).resolves.toBe(false);
    expect(set).not.toHaveBeenCalled();
  });

  it('does not bind to a set created more than 2 hours ago', async () => {
    const { store, set } = makeStore();
    await store.add(makeSet({ createdAt: new Date(NOW - 3 * HOUR).toISOString() }));
    set.mockClear();

    await expect(
      store.bindDelivery('conv-1', { channel: 'email', messageId: 'm1', at: new Date(NOW).toISOString() }),
    ).resolves.toBe(false);
    expect(set).not.toHaveBeenCalled();
  });

  it('binds to the newest set when a conversation has more than one', async () => {
    const { store, stored } = makeStore();
    await store.add(makeSet({ id: 'older', createdAt: new Date(NOW - HOUR).toISOString() }));
    await store.add(makeSet({ id: 'newer', createdAt: new Date(NOW - 60_000).toISOString() }));
    await store.bindDelivery('conv-1', { channel: 'signal', messageId: 'm1', at: new Date(NOW).toISOString() });

    const byId = Object.fromEntries(stored().sets.map((s) => [s.id, s]));
    expect(byId['newer']!.deliveries).toHaveLength(1);
    expect(byId['older']!.deliveries).toHaveLength(0);
  });

  it('lets a config-store read error propagate', async () => {
    const { store } = makeStore({ getError: new Error('db down') });
    await expect(store.add(makeSet())).rejects.toThrow('db down');
    await expect(store.bindDelivery('conv-1', { channel: 'email', messageId: 'm', at: new Date(NOW).toISOString() }))
      .rejects.toThrow('db down');
    await expect(store.findByEmailThread('th1')).rejects.toThrow('db down');
    await expect(store.findLatestDelivered(DAY)).rejects.toThrow('db down');
  });
});
