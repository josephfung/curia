// Integration test — PrincipalMailboxStore against real Postgres (#2475). Skips without DATABASE_URL.
// This file is the only one that commits rows to principal_mailboxes; it clears only the ids it uses.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { PrincipalMailboxStore } from '../../src/principal-mailboxes/store.js';
import type { PrincipalMailboxRecord } from '../../src/principal-mailboxes/types.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const logger = pino({ level: 'silent' });
// The ids this suite creates; cleanup is scoped to them, never the whole table.
const TEST_IDS = ['work', 'personal'];

function rec(id: string, over: Partial<Omit<PrincipalMailboxRecord, 'removedAt'>> = {}): Omit<PrincipalMailboxRecord, 'removedAt'> {
  return {
    id,
    label: id,
    address: `${id}@example.com`,
    provider: 'google',
    isDefault: false,
    triageStartAt: null,
    addedIdentityId: null,
    ...over,
  };
}

describeIf('PrincipalMailboxStore', () => {
  let pool: pg.Pool;
  let store: PrincipalMailboxStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    store = new PrincipalMailboxStore(pool, logger);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM principal_mailboxes WHERE id = ANY($1)', [TEST_IDS]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM principal_mailboxes WHERE id = ANY($1)', [TEST_IDS]);
    await pool.end();
  });

  it('setDefault moves the default in one transaction', async () => {
    await store.insert(rec('work', { isDefault: true }));
    await store.insert(rec('personal'));
    await store.setDefault('personal');
    const live = await store.listLive();
    expect(live.map((r) => [r.id, r.isDefault])).toEqual([
      ['personal', true],
      ['work', false],
    ]);
  });

  it('setDefault of an unknown id throws and leaves the old default in place', async () => {
    await store.insert(rec('work', { isDefault: true }));
    await expect(store.setDefault('nope')).rejects.toThrow();
    expect((await store.getAny('work'))?.isDefault).toBe(true);
  });

  it('tombstone sets removed_at and hands default to newDefaultId', async () => {
    await store.insert(rec('work', { isDefault: true }));
    await store.insert(rec('personal'));
    await store.tombstone('work', 'personal');
    const work = await store.getAny('work');
    expect(work?.removedAt).toBeInstanceOf(Date);
    expect(work?.isDefault).toBe(false);
    expect((await store.getAny('personal'))?.isDefault).toBe(true);
  });

  it('tombstone of the default with others live and no newDefaultId throws', async () => {
    await store.insert(rec('work', { isDefault: true }));
    await store.insert(rec('personal'));
    await expect(store.tombstone('work', null)).rejects.toThrow();
    expect((await store.getAny('work'))?.removedAt).toBeNull();
  });

  it('tombstone of the only mailbox needs no newDefaultId', async () => {
    await store.insert(rec('work', { isDefault: true }));
    await store.tombstone('work', null);
    expect(await store.listLive()).toEqual([]);
  });

  it('listLive excludes removed rows', async () => {
    await store.insert(rec('work', { isDefault: true }));
    await store.insert(rec('personal'));
    await store.tombstone('personal', null);
    expect((await store.listLive()).map((r) => r.id)).toEqual(['work']);
  });

  it('getAny returns removed rows and null for unknown ids', async () => {
    await store.insert(rec('work', { isDefault: true }));
    await store.tombstone('work', null);
    expect((await store.getAny('work'))?.removedAt).toBeInstanceOf(Date);
    expect(await store.getAny('nope')).toBeNull();
  });

  it('relabel changes the label only', async () => {
    await store.insert(rec('work', { isDefault: true }));
    await store.relabel('work', 'Work mail');
    const r = await store.getAny('work');
    expect(r?.label).toBe('Work mail');
    expect(r?.address).toBe('work@example.com');
  });

  it('insert joins a caller-supplied transaction client', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await store.insert(rec('work', { isDefault: true }), client);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await store.getAny('work')).toBeNull();
  });

  it('inserting a default moves the default in one step', async () => {
    await store.insert(rec('work', { isDefault: true }));
    await store.insert(rec('personal', { isDefault: true }));
    const live = await store.listLive();
    expect(live.map((r) => [r.id, r.isDefault])).toEqual([['personal', true], ['work', false]]);
  });

  it('hasAnyRow is false for an empty table', async () => {
    // This file is the only one that commits rows here, so after the scoped cleanup the table
    // must be empty; fail loudly rather than assert against someone else's rows.
    const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM principal_mailboxes');
    expect(Number(rows[0]!.n)).toBe(0);
    expect(await store.hasAnyRow()).toBe(false);
  });

  it('hasAnyRow is true when the only rows are removed ones', async () => {
    await store.insert(rec('work', { isDefault: true }));
    await store.tombstone('work', null);
    expect(await store.listLive()).toEqual([]);
    expect(await store.hasAnyRow()).toBe(true);
  });

  it('a failed default insert keeps the old default', async () => {
    await store.insert(rec('work', { isDefault: true }));
    await expect(store.insert(rec('work', { isDefault: true }))).rejects.toThrow();
    expect((await store.getAny('work'))?.isDefault).toBe(true);
  });
});
