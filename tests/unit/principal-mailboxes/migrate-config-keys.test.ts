import { describe, it, expect, vi } from 'vitest';
import { migrateSendingKey, renameSendingKeyAfterMigration, dropLegacyDefaultKey, reconcileLegacySendingKey } from '../../../src/principal-mailboxes/migrate-config-keys.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {} } as never;

function store(initial: string | null) {
  let value = initial;
  const writes: string[] = [];
  return {
    get: async (_ns: string, _key: string) => value,
    set: async (_ns: string, _key: string, v: string) => { value = v; writes.push(v); return { stored: true, action: 'created' }; },
    current: () => value,
    writes,
  };
}

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
