import { describe, it, expect, vi } from 'vitest';
import { migrateSendingKey, renameSendingKeyAfterMigration, dropLegacyDefaultKey, reconcileLegacySendingKey, SendingKeyNotStoredError, migrateLearningKeys, reconcileLearningKeys } from '../../../src/principal-mailboxes/migrate-config-keys.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {} } as never;

const SENDING = 'ceo_inbox/sending';

/** A keyed in-memory config store; `current()` / `writes` follow the ceo_inbox/sending value. */
function keyedStore(initial: string | null, extra: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(extra));
  if (initial !== null) values.set(SENDING, initial);
  const writes: string[] = [];
  const all: Array<[string, string]> = [];
  return {
    get: async (ns: string, key: string) => values.get(`${ns}/${key}`) ?? null,
    set: async (ns: string, key: string, v: string) => {
      values.set(`${ns}/${key}`, v);
      all.push([`${ns}/${key}`, v]);
      if (`${ns}/${key}` === SENDING) writes.push(v);
      return { stored: true, action: 'created' };
    },
    current: () => values.get(SENDING) ?? null,
    value: (ns: string, key: string) => values.get(`${ns}/${key}`) ?? null,
    writes,
    all,
  };
}
const store = (initial: string | null) => keyedStore(initial);

describe('unparseable sending value', () => {
  it('logs a warning and leaves the value alone', async () => {
    const warn = vi.fn();
    const logger = { info: () => {}, warn, error: () => {} } as never;
    const s = store('not json');
    expect(await migrateSendingKey(s, 'work', logger)).toBe('nothing');
    await dropLegacyDefaultKey(s, logger);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(s.writes).toHaveLength(0);
  });
});

describe('a write the store declines', () => {
  const declining = (initial: string) => ({
    get: async () => initial,
    set: async () => ({ stored: false, action: 'rate_limited' }),
  });
  it('is not reported as renamed or dropped', async () => {
    await expect(migrateSendingKey(declining('{"default":"routine"}'), 'work', quiet)).rejects.toBeInstanceOf(SendingKeyNotStoredError);
    await expect(dropLegacyDefaultKey(declining('{"default":"routine"}'), quiet)).rejects.toBeInstanceOf(SendingKeyNotStoredError);
  });
  it('goes to the reconcile retry path, which logs instead of reporting a rename', async () => {
    const info = vi.fn();
    const warn = vi.fn();
    const logger = { info, warn, error: () => {} } as never;
    const run = renameSendingKeyAfterMigration({
      migrate: async () => 'already',
      mailboxes: async () => [{ id: 'work', triageStartAt: null }],
      isFallbackActive: async () => false,
      store: () => declining('{"default":"routine"}'),
      logger,
    });
    await run();
    expect(info).not.toHaveBeenCalledWith('Renamed the default send-level key to the migrated mailbox id');
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ errName: 'SendingKeyNotStoredError' }), expect.stringContaining('retried'));
  });
});

describe('migrateSendingKey', () => {
  it('renames default once and is idempotent', async () => {
    const s = store('{"default":"routine"}');
    expect(await migrateSendingKey(s, 'work', quiet)).toBe('renamed');
    expect(JSON.parse(s.current()!)).toEqual({ work: 'routine' });
    expect(await migrateSendingKey(s, 'work', quiet)).toBe('nothing');
    expect(s.writes).toHaveLength(1);
  });
  it('does nothing when unset, unparseable or without a default key', async () => {
    for (const raw of [null, 'not json', '[1]', '{"work":"all"}']) {
      const s = store(raw);
      expect(await migrateSendingKey(s, 'work', quiet), String(raw)).toBe('nothing');
      expect(s.writes).toHaveLength(0);
    }
  });
  it('keeps an existing entry for the id and drops the stale default', async () => {
    const s = store('{"default":"all","work":"off"}');
    expect(await migrateSendingKey(s, 'work', quiet)).toBe('renamed');
    expect(JSON.parse(s.current()!)).toEqual({ work: 'off' });
  });
  it('keeps other mailboxes entries', async () => {
    const s = store('{"default":"all","personal":"routine"}');
    await migrateSendingKey(s, 'work', quiet);
    expect(JSON.parse(s.current()!)).toEqual({ work: 'all', personal: 'routine' });
  });
});

const migratedRow = (id: string) => ({ id, triageStartAt: null });
const addedRow = (id: string) => ({ id, triageStartAt: new Date('2026-11-01T00:00:00Z') });

describe('renameSendingKeyAfterMigration (R41, B1, S-I1)', () => {
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;
  const deps = (s: ReturnType<typeof store>, rows: Array<{ id: string; triageStartAt: Date | null }>, outcome: 'migrated' | 'already' | 'deferred' | 'nothing' = 'migrated') => ({
    migrate: async () => outcome, mailboxes: async () => rows, isFallbackActive: async () => false, store: () => s, logger,
  });

  it("renames to the migrated mailbox's id when the migration returns 'migrated'", async () => {
    const s = store('{"default":"routine"}');
    expect(await renameSendingKeyAfterMigration(deps(s, [migratedRow('gmail')]))()).toBe('migrated');
    expect(JSON.parse(s.current()!)).toEqual({ gmail: 'routine' });
  });

  it("renames on 'already' too: an install migrated by an earlier release (B1)", async () => {
    const s = store('{"default":"routine"}');
    expect(await renameSendingKeyAfterMigration(deps(s, [migratedRow('gmail')], 'already'))()).toBe('already');
    expect(JSON.parse(s.current()!)).toEqual({ gmail: 'routine' });
  });

  it('renames to the migrated mailbox even with a second mailbox added since (S-I1)', async () => {
    const s = store('{"default":"all","personal":"off"}');
    await renameSendingKeyAfterMigration(deps(s, [addedRow('personal'), migratedRow('gmail')], 'already'))();
    expect(JSON.parse(s.current()!)).toEqual({ gmail: 'all', personal: 'off' });
  });

  it('drops the key when the migrated mailbox is gone and another is live (S-I1)', async () => {
    const s = store('{"default":"all"}');
    await renameSendingKeyAfterMigration(deps(s, [addedRow('home')], 'already'))();
    expect(JSON.parse(s.current()!)).toEqual({});
  });

  it('leaves the key while the fallback is served or nothing is live', async () => {
    const s = store('{"default":"all"}');
    await renameSendingKeyAfterMigration({ ...deps(s, [migratedRow('mailbox')], 'deferred'), isFallbackActive: async () => true })();
    await renameSendingKeyAfterMigration(deps(s, [], 'nothing'))();
    expect(s.writes).toHaveLength(0);
  });

  it('waits for the store (boot), logs that once, then flush renames it (SF17)', async () => {
    const s = store('{"default":"all"}');
    const info = vi.fn();
    let have = false;
    const run = renameSendingKeyAfterMigration({ ...deps(s, [migratedRow('gmail')]), store: () => (have ? s : undefined), logger: { info, warn: () => {}, error: () => {}, debug: () => {} } as never });
    await run();
    await run();
    expect(s.writes).toHaveLength(0);
    expect(info.mock.calls.filter((c) => /waits for the config store/.test(String(c.at(-1))))).toHaveLength(1);
    have = true;
    await run.flush();
    expect(JSON.parse(s.current()!)).toEqual({ gmail: 'all' });
  });
});

describe('renameSendingKeyAfterMigration retries a failed flush', () => {
  it('logs the failure and renames on the next run', async () => {
    const warn = vi.fn();
    const logger = { info: () => {}, warn, error: () => {}, debug: () => {} } as never;
    const s = store('{"default":"all"}');
    let failing = true;
    const failingStore = { get: s.get, set: async (n: string, k: string, v: string) => { if (failing) throw new Error('kg down'); return s.set(n, k, v); } };
    let outcome: 'migrated' | 'already' = 'migrated';
    const run = renameSendingKeyAfterMigration({ migrate: async () => outcome, mailboxes: async () => [migratedRow('gmail')], isFallbackActive: async () => false, store: () => failingStore, logger });
    await run();
    expect(s.writes).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    failing = false;
    outcome = 'already';
    await run();
    expect(JSON.parse(s.current()!)).toEqual({ gmail: 'all' });
  });
});

describe('reconcileLegacySendingKey', () => {
  it('does nothing without a default key', async () => {
    const s = store('{"gmail":"all"}');
    expect(await reconcileLegacySendingKey({ store: s, mailboxes: [addedRow('home')], fallbackActive: false, logger: quiet })).toBe('nothing');
    expect(s.writes).toHaveLength(0);
  });
});

describe('dropLegacyDefaultKey', () => {
  it('removes only the default entry, and does nothing when there is none', async () => {
    const s = store('{"default":"all","work":"off"}');
    expect(await dropLegacyDefaultKey(s, quiet)).toBe(true);
    expect(JSON.parse(s.current()!)).toEqual({ work: 'off' });
    expect(await dropLegacyDefaultKey(s, quiet)).toBe(false);
    expect(s.writes).toHaveLength(1);
  });
});

const NS = 'ceo_inbox';
const g = (name: string) => `${NS}/sent_observe.${name}`;
const m = (id: string, name: string) => `${NS}/sent_observe.${id}.${name}`;

describe('migrateLearningKeys (D8, R60)', () => {
  const globals = {
    [g('last_seen_at')]: '1700000000',
    [g('backfill_before')]: '0',
    [g('matched_draft_ids')]: '["d1"]',
    [g('completion_candidates')]: '{"t1":{}}',
    [g('asked_task_ids')]: '["t1"]',
    // Not per mailbox: must stay.
    [g('completion_digest')]: '{"t1":{}}',
    [g('completion_digest_high_water')]: '3',
    [`${NS}/voice_learn.proposal`]: '{"status":"pending"}',
  };

  it('moves global keys to the mailbox once and leaves the global-only keys', async () => {
    const s = keyedStore(null, globals);
    expect(await migrateLearningKeys(s, 'gmail', quiet)).toBe(5);
    expect(s.value(NS, 'sent_observe.gmail.last_seen_at')).toBe('1700000000');
    expect(s.value(NS, 'sent_observe.gmail.backfill_before')).toBe('0');
    expect(s.value(NS, 'sent_observe.gmail.matched_draft_ids')).toBe('["d1"]');
    expect(s.value(NS, 'sent_observe.gmail.completion_candidates')).toBe('{"t1":{}}');
    expect(s.value(NS, 'sent_observe.gmail.asked_task_ids')).toBe('["t1"]');
    // Cleared, not deleted (the config store has no delete; readers treat '' as unset).
    expect(s.value(NS, 'sent_observe.last_seen_at')).toBe('');
    expect(s.value(NS, 'sent_observe.completion_digest')).toBe('{"t1":{}}');
    expect(s.value(NS, 'sent_observe.completion_digest_high_water')).toBe('3');
    expect(s.value(NS, 'voice_learn.proposal')).toBe('{"status":"pending"}');
  });

  it('is idempotent: a second run writes nothing', async () => {
    const s = keyedStore(null, globals);
    await migrateLearningKeys(s, 'gmail', quiet);
    const writes = s.all.length;
    expect(await migrateLearningKeys(s, 'gmail', quiet)).toBe(0);
    expect(s.all).toHaveLength(writes);
  });

  it('lets an existing per-mailbox key win over the global one', async () => {
    const s = keyedStore(null, { ...globals, [m('gmail', 'last_seen_at')]: '1800000000' });
    await migrateLearningKeys(s, 'gmail', quiet);
    expect(s.value(NS, 'sent_observe.gmail.last_seen_at')).toBe('1800000000');
    expect(s.value(NS, 'sent_observe.last_seen_at')).toBe('');
  });

  it('does not count a clear that was soft-rejected', async () => {
    const s = keyedStore(null, { [g('last_seen_at')]: '17' });
    const warn = vi.fn();
    const rejectClear = { get: s.get, set: async (n: string, k: string, v: string) => (v === '' ? { stored: false, action: 'conflict' } : s.set(n, k, v)) };
    expect(await migrateLearningKeys(rejectClear, 'gmail', { info: () => {}, warn, error: () => {} } as never)).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('keeps the global key when the copy is soft-rejected', async () => {
    const s = keyedStore(null, { [g('last_seen_at')]: '17' });
    const warn = vi.fn();
    const rejecting = { get: s.get, set: async () => ({ stored: false, action: 'conflict' }) };
    expect(await migrateLearningKeys(rejecting, 'gmail', { info: () => {}, warn, error: () => {} } as never)).toBe(0);
    expect(s.value(NS, 'sent_observe.last_seen_at')).toBe('17');
    expect(warn).toHaveBeenCalled();
  });
});

describe('reconcileLearningKeys targets the migrated mailbox, not the default (R60)', () => {
  const rows = [
    { id: 'personal', triageStartAt: new Date('2026-11-01T00:00:00Z') }, // the current default, added later
    { id: 'gmail', triageStartAt: null }, // the migrated one
  ];
  const seed = { [g('last_seen_at')]: '1700000000', [g('asked_task_ids')]: '["t1"]' };

  it('moves to the migrated mailbox even when another mailbox is the default', async () => {
    const s = keyedStore(null, seed);
    expect(await reconcileLearningKeys({ store: s, mailboxes: rows, fallbackActive: false, logger: quiet })).toBe('moved');
    expect(s.value(NS, 'sent_observe.gmail.last_seen_at')).toBe('1700000000');
    expect(s.value(NS, 'sent_observe.personal.last_seen_at')).toBeNull();
  });

  it('does nothing while the fallback is served or no mailbox is live', async () => {
    const s = keyedStore(null, seed);
    expect(await reconcileLearningKeys({ store: s, mailboxes: [{ id: 'mailbox', triageStartAt: null }], fallbackActive: true, logger: quiet })).toBe('nothing');
    expect(await reconcileLearningKeys({ store: s, mailboxes: [], fallbackActive: false, logger: quiet })).toBe('nothing');
    expect(s.all).toHaveLength(0);
  });

  it('leaves the global keys and reports no_target when the migrated mailbox is gone', async () => {
    const s = keyedStore(null, seed);
    expect(await reconcileLearningKeys({ store: s, mailboxes: [rows[0]!], fallbackActive: false, logger: quiet })).toBe('no_target');
    expect(s.all).toHaveLength(0);
  });
});

describe('renameSendingKeyAfterMigration also moves the learning keys', () => {
  const seed = { [g('last_seen_at')]: '1700000000' };
  const deps = (s: ReturnType<typeof keyedStore>, rows: Array<{ id: string; triageStartAt: Date | null }>, outcome: 'migrated' | 'already' = 'already', logger: never = quiet) => ({
    migrate: async () => outcome, mailboxes: async () => rows, isFallbackActive: async () => false, store: () => s, logger,
  });

  it("runs on 'already' (every boot) and after a runtime migration", async () => {
    for (const outcome of ['already', 'migrated'] as const) {
      const s = keyedStore(null, seed);
      await renameSendingKeyAfterMigration(deps(s, [{ id: 'gmail', triageStartAt: null }], outcome))();
      expect(s.value(NS, 'sent_observe.gmail.last_seen_at'), outcome).toBe('1700000000');
    }
  });

  it('logs the missing target once and a failing move does not break the send-level rename', async () => {
    const info = vi.fn();
    const logger = { info, warn: () => {}, error: () => {}, debug: () => {} } as never;
    const s = keyedStore('{"default":"all"}', seed);
    const run = renameSendingKeyAfterMigration(deps(s, [{ id: 'home', triageStartAt: new Date() }], 'already', logger));
    await run();
    await run();
    expect(info.mock.calls.filter((c) => /No migrated mailbox is live/.test(String(c.at(-1))))).toHaveLength(1);
    const warn = vi.fn();
    const s2 = keyedStore('{"default":"all"}', seed);
    const failing = { ...s2, set: async (n: string, k: string, v: string) => { if (k.startsWith('sent_observe')) throw new Error('kg down'); return s2.set(n, k, v); } };
    await renameSendingKeyAfterMigration({ ...deps(s2, [{ id: 'gmail', triageStartAt: null }], 'already', { info: () => {}, warn, error: () => {}, debug: () => {} } as never), store: () => failing })();
    expect(JSON.parse(s2.current()!)).toEqual({ gmail: 'all' });
    expect(warn).toHaveBeenCalled();
  });
});
