// SpotCheckStore — digest number-to-action maps kept in the config store (#2159).
import { describe, it, expect, vi, afterEach } from 'vitest';
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

// The delivered message: the block as the sampler renders it for makeSet()'s items.
const DIGEST = "Today's recap\n\nSpot check (optional, reply with a number):\n1. Replied to Dana about the Thursday slot.\n2. Declined a vendor call from Sam.";

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
      store.bindDelivery(set.conversationId, { channel: 'email', messageId: 'm1', threadId: 'th1', at }, DIGEST),
    ).resolves.toMatchObject({ kind: 'bound', set: { id: 'set-1' } });

    expect((await store.findByEmailThread('th1'))?.id).toBe('set-1');
    expect((await store.findLatestDelivered(DAY))?.id).toBe('set-1');
    expect(await store.findByEmailThread('other-thread')).toBeNull();
  });

  it('does not append the same messageId twice', async () => {
    const { store, stored } = makeStore();
    const set = makeSet();
    await store.add(set);
    const delivery = { channel: 'email', messageId: 'm1', threadId: 'th1', at: new Date(NOW).toISOString() };
    await store.bindDelivery(set.conversationId, delivery, DIGEST);
    await store.bindDelivery(set.conversationId, delivery, DIGEST);
    expect(stored().sets[0]!.deliveries).toHaveLength(1);
  });

  it('returns the set with the later delivery as latest, and each set by its own thread', async () => {
    const { store } = makeStore();
    await store.add(makeSet({ id: 'a', conversationId: 'conv-a' }));
    await store.add(makeSet({ id: 'b', conversationId: 'conv-b' }));
    await store.bindDelivery('conv-a', {
      channel: 'email', messageId: 'ma', threadId: 'th-a', at: new Date(NOW - 3 * HOUR).toISOString(),
    }, DIGEST);
    await store.bindDelivery('conv-b', {
      channel: 'email', messageId: 'mb', threadId: 'th-b', at: new Date(NOW - 1 * HOUR).toISOString(),
    }, DIGEST);

    expect((await store.findLatestDelivered(DAY))?.id).toBe('b');
    expect((await store.findByEmailThread('th-a'))?.id).toBe('a');
    expect((await store.findByEmailThread('th-b'))?.id).toBe('b');
  });

  it('ignores a delivery older than the window for latest, but still finds it by thread', async () => {
    const { store } = makeStore();
    await store.add(makeSet());
    await store.bindDelivery('conv-1', {
      channel: 'email', messageId: 'm1', threadId: 'th1', at: new Date(NOW - 25 * HOUR).toISOString(),
    }, DIGEST);

    expect(await store.findLatestDelivered(DAY)).toBeNull();
    expect((await store.findByEmailThread('th1'))?.id).toBe('set-1');
  });

  it('reports whether another set was created after a given instant within the window', async () => {
    const { store } = makeStore();
    await store.add(makeSet({ id: 'old', createdAt: new Date(NOW - 10 * HOUR).toISOString() }));
    await store.add(makeSet({ id: 'new', createdAt: new Date(NOW - 10 * 60_000).toISOString() }));

    // 'new' was created after the instant, whether or not it was ever delivered.
    expect(await store.hasSetCreatedAfter(NOW - HOUR, DAY, 'old')).toBe(true);
    // The set being resolved is never counted against itself.
    expect(await store.hasSetCreatedAfter(NOW - HOUR, DAY, 'new')).toBe(false);
    // Nothing created after the instant.
    expect(await store.hasSetCreatedAfter(NOW - 60_000, DAY, 'old')).toBe(false);
    // Outside the window does not count.
    expect(await store.hasSetCreatedAfter(NOW - 11 * HOUR, 5 * 60_000, 'none')).toBe(false);
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

  it('returns no_set from bindDelivery for an unknown conversation and writes nothing', async () => {
    const { store, set } = makeStore();
    await store.add(makeSet());
    set.mockClear();

    await expect(
      store.bindDelivery('no-such-conversation', { channel: 'email', messageId: 'm1', at: new Date(NOW).toISOString() }, DIGEST),
    ).resolves.toEqual({ kind: 'no_set' });
    expect(set).not.toHaveBeenCalled();
  });

  it('does not bind to a set created more than 2 hours ago', async () => {
    const { store, set } = makeStore();
    await store.add(makeSet({ createdAt: new Date(NOW - 3 * HOUR).toISOString() }));
    set.mockClear();

    await expect(
      store.bindDelivery('conv-1', { channel: 'email', messageId: 'm1', at: new Date(NOW).toISOString() }, DIGEST),
    ).resolves.toEqual({ kind: 'no_set' });
    expect(set).not.toHaveBeenCalled();
  });

  it('binds to the newest set when a conversation has more than one', async () => {
    const { store, stored } = makeStore();
    await store.add(makeSet({ id: 'older', createdAt: new Date(NOW - HOUR).toISOString() }));
    await store.add(makeSet({ id: 'newer', createdAt: new Date(NOW - 60_000).toISOString() }));
    await store.bindDelivery('conv-1', { channel: 'signal', messageId: 'm1', at: new Date(NOW).toISOString() }, DIGEST);

    const byId = Object.fromEntries(stored().sets.map((s) => [s.id, s]));
    expect(byId['newer']!.deliveries).toHaveLength(1);
    expect(byId['older']!.deliveries).toHaveLength(0);
  });

  it('returns rejected from bindDelivery when the config store soft-rejects the write', async () => {
    const { store, set } = makeStore();
    await store.add(makeSet());
    set.mockResolvedValueOnce({ stored: false });

    await expect(
      store.bindDelivery('conv-1', { channel: 'signal', messageId: 'm1', at: new Date(NOW).toISOString() }, DIGEST),
    ).resolves.toEqual({ kind: 'rejected' });
  });

  it('returns the bound set, without writing again, for a messageId already recorded', async () => {
    const { store, set } = makeStore();
    await store.add(makeSet());
    const delivery = { channel: 'signal', messageId: 'm1', at: new Date(NOW).toISOString() };
    await store.bindDelivery('conv-1', delivery, DIGEST);
    set.mockClear();

    await expect(store.bindDelivery('conv-1', delivery, DIGEST)).resolves.toMatchObject({ kind: 'bound', set: { id: 'set-1' } });
    expect(set).not.toHaveBeenCalled();
  });

  // Two digests composed in one conversation (a retry, or a second draw) each store a set. The
  // delivery belongs to the set whose numbered lines the message actually shows.
  describe('choosing between sets of one conversation', () => {
    const older = makeSet({
      id: 'older',
      createdAt: new Date(NOW - HOUR).toISOString(),
      items: [{ n: 1, actionLogId: 201, summary: 'Archive an email: "Statement ready"' }],
    });
    const newer = makeSet({
      id: 'newer',
      createdAt: new Date(NOW - 60_000).toISOString(),
      items: [{ n: 1, actionLogId: 301, summary: 'Accepted the Q3 sync invite' }],
    });
    const delivery = { channel: 'signal', messageId: 'm1', at: new Date(NOW).toISOString() };

    it('binds the set whose first line the content shows, even when it is not the newest', async () => {
      const { store, stored } = makeStore();
      await store.add(older);
      await store.add(newer);

      const result = await store.bindDelivery('conv-1', delivery, 'Spot check (optional, reply with a number):\n1. Archive an email: "Statement ready"');

      expect(result).toMatchObject({ kind: 'bound', set: { id: 'older' } });
      const byId = Object.fromEntries(stored().sets.map((s) => [s.id, s]));
      expect(byId['older']!.deliveries).toHaveLength(1);
      expect(byId['newer']!.deliveries).toHaveLength(0);
    });

    // "1. Send email to Bob" is a prefix of "1. Send email to Bobby": a bare substring match
    // would bind the wrong set's numbers.
    it('matches the first line whole, not as a prefix of a longer line', async () => {
      const { store, stored } = makeStore();
      await store.add(makeSet({
        id: 'bobby', createdAt: new Date(NOW - HOUR).toISOString(),
        items: [{ n: 1, actionLogId: 401, summary: 'Send email to Bobby' }],
      }));
      await store.add(makeSet({
        id: 'bob', createdAt: new Date(NOW - 60_000).toISOString(),
        items: [{ n: 1, actionLogId: 402, summary: 'Send email to Bob' }],
      }));

      const result = await store.bindDelivery('conv-1', delivery, 'Spot check (optional, reply with a number):\n1. Send email to Bobby\n2. Other');

      expect(result).toMatchObject({ kind: 'bound', set: { id: 'bobby' } });
      const byId = Object.fromEntries(stored().sets.map((s) => [s.id, s]));
      expect(byId['bob']!.deliveries).toHaveLength(0);
    });

    it('matches a first line at the very end of the content', async () => {
      const { store } = makeStore();
      await store.add(older);
      await store.add(newer);

      await expect(store.bindDelivery('conv-1', delivery, 'Spot check (optional, reply with a number):\n1. Archive an email: "Statement ready"'))
        .resolves.toMatchObject({ kind: 'bound', set: { id: 'older' } });
    });

    it('matches a first line ending in CRLF', async () => {
      const { store } = makeStore();
      await store.add(older);
      await store.add(newer);

      await expect(store.bindDelivery('conv-1', delivery, 'Spot check (optional, reply with a number):\r\n1. Archive an email: "Statement ready"\r\n2. x'))
        .resolves.toMatchObject({ kind: 'bound', set: { id: 'older' } });
    });

    it('binds nothing when the content matches neither of several sets', async () => {
      const { store, set } = makeStore();
      await store.add(older);
      await store.add(newer);
      set.mockClear();

      await expect(store.bindDelivery('conv-1', delivery, 'Spot check (optional, reply with a number):\n1. something reworded'))
        .resolves.toEqual({ kind: 'no_set' });
      expect(set).not.toHaveBeenCalled();
    });

    it('binds the only set when the content does not show its first line verbatim', async () => {
      const { store } = makeStore();
      await store.add(newer);

      await expect(store.bindDelivery('conv-1', delivery, 'Spot check (optional, reply with a number):\n1) Accepted the Q3 sync'))
        .resolves.toMatchObject({ kind: 'bound', set: { id: 'newer' } });
    });
  });

  // add() and bindDelivery() read the whole list, change it and write it back. The tool and the
  // boot wiring each build their own store, so two digests drawn at once must not lose a set.
  it('keeps both sets when two store instances add at the same time', async () => {
    const { get, set, stored } = makeStore();
    const logger = createSilentLogger();
    const a = new SpotCheckStore({ get, set }, logger, () => NOW);
    const b = new SpotCheckStore({ get, set }, logger, () => NOW);

    await Promise.all([
      a.add(makeSet({ id: 'a', conversationId: 'conv-a' })),
      b.add(makeSet({ id: 'b', conversationId: 'conv-b' })),
    ]);

    expect(stored().sets.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('serializes a bind behind an add, and a failed op does not block the next one', async () => {
    const { get, set, stored } = makeStore();
    const logger = createSilentLogger();
    const a = new SpotCheckStore({ get, set }, logger, () => NOW);
    const b = new SpotCheckStore({ get, set }, logger, () => NOW);
    get.mockRejectedValueOnce(new Error('db blip'));

    const results = await Promise.allSettled([
      a.add(makeSet({ id: 'lost', conversationId: 'conv-x' })),
      b.add(makeSet({ id: 'kept', conversationId: 'conv-1' })),
      a.bindDelivery('conv-1', { channel: 'signal', messageId: 'm1', at: new Date(NOW).toISOString() }, DIGEST),
    ]);

    // The failure reaches only its own caller.
    expect(results[0]!.status).toBe('rejected');
    expect(results[1]!.status).toBe('fulfilled');
    expect(results[2]!.status).toBe('fulfilled');
    expect(stored().sets.map((s) => s.id)).toEqual(['kept']);
    expect(stored().sets[0]!.deliveries).toHaveLength(1);
  });

  // Production runs the tsup bundle, which carries its own copy of this module, while the
  // list-spot-checks handler imports it from source: two module instances. They must share one
  // queue, so it lives on globalThis rather than in a module variable.
  it('shares the write queue between two independent copies of the module', async () => {
    vi.resetModules();
    const first = await import('../../../src/reports/spot-check-store.js');
    vi.resetModules();
    const second = await import('../../../src/reports/spot-check-store.js');
    expect(first.SpotCheckStore).not.toBe(second.SpotCheckStore);

    const { get, set, stored } = makeStore();
    const logger = createSilentLogger();
    await Promise.all([
      new first.SpotCheckStore({ get, set }, logger, () => NOW).add(makeSet({ id: 'a', conversationId: 'conv-a' })),
      new second.SpotCheckStore({ get, set }, logger, () => NOW).add(makeSet({ id: 'b', conversationId: 'conv-b' })),
    ]);

    expect(stored().sets.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('waits for an op queued on the shared chain through the global symbol', async () => {
    const holder = globalThis as unknown as Record<symbol, { tail: Promise<void> } | undefined>;
    const chain = holder[Symbol.for('curia.spotCheckStore.mutationChain')];
    expect(chain).toBeDefined();

    // Queue an op the way another module copy would, and hold it open.
    let release!: () => void;
    const held = chain!.tail.then(() => new Promise<void>((resolve) => { release = resolve; }));
    chain!.tail = held;

    const { store, set } = makeStore();
    const adding = store.add(makeSet());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(set).not.toHaveBeenCalled();

    release();
    await expect(adding).resolves.toBe(true);
    expect(set).toHaveBeenCalledTimes(1);
  });

  describe('a config store that never answers', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('times the op out to its own caller, releases the queue, and skips the late write', async () => {
      vi.useFakeTimers();
      const { store, get, set, stored } = makeStore();
      let answer!: (v: string | null) => void;
      get.mockImplementationOnce(() => new Promise<string | null>((resolve) => { answer = resolve; }));

      const hung = store.add(makeSet({ id: 'hung', conversationId: 'conv-hung' }));
      const hungResult = hung.then(() => 'resolved', (err: Error) => err.message);
      const next = store.add(makeSet({ id: 'next', conversationId: 'conv-next' }));

      await vi.advanceTimersByTimeAsync(10_000);
      expect(await hungResult).toMatch(/timed out/);
      await expect(next).resolves.toBe(true);
      expect(stored().sets.map((s) => s.id)).toEqual(['next']);

      // The abandoned op's read finally answers: it must not write its stale list over 'next'.
      set.mockClear();
      answer(null);
      await vi.advanceTimersByTimeAsync(0);
      expect(set).not.toHaveBeenCalled();
      expect(stored().sets.map((s) => s.id)).toEqual(['next']);
    });
  });

  it('lets a config-store read error propagate', async () => {
    const { store } = makeStore({ getError: new Error('db down') });
    await expect(store.add(makeSet())).rejects.toThrow('db down');
    await expect(store.bindDelivery('conv-1', { channel: 'email', messageId: 'm', at: new Date(NOW).toISOString() }, DIGEST))
      .rejects.toThrow('db down');
    await expect(store.findByEmailThread('th1')).rejects.toThrow('db down');
    await expect(store.findLatestDelivered(DAY)).rejects.toThrow('db down');
  });
});
