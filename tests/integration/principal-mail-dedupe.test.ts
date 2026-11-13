// TriageDedupe over a real principal_mail_dedupe table (migration 125, #2475 D4).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { TriageDedupe } from '../../src/principal-mailboxes/triage-dedupe.js';
import { createSilentLogger } from '../../src/logger.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env['DATABASE_URL'];
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('TriageDedupe', () => {
  let pool: pg.Pool;
  let dedupe: TriageDedupe;
  const suffix = randomBytes(4).toString('hex');
  let seq = 0;

  // Unique per test; every header ends in the per-run suffix so cleanup touches only our rows.
  const FROM = 'sender@example.org';
  const header = () => `<msg${(seq += 1)}-${suffix}@example.com>`;

  // Teardown deletes only after the database was confirmed to be curia_test.
  let dbValidated = false;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    dbValidated = true;
    dedupe = new TriageDedupe(pool, createSilentLogger());
  });

  afterAll(async () => {
    try {
      if (dbValidated) await pool.query(`DELETE FROM principal_mail_dedupe WHERE message_id_header LIKE $1`, [`%-${suffix}@example.com`]);
    } finally {
      await pool.end();
    }
  });

  it('first claim wins', async () => {
    expect(await dedupe.claim(header(), FROM, 'work', 'n1')).toEqual({ first: true });
  });

  it('second claim returns the winner', async () => {
    const h = header();
    await dedupe.claim(h, FROM, 'work', 'n1');
    expect(await dedupe.claim(h, FROM, 'personal', 'n2')).toEqual({ first: false, mailboxId: 'work', nylasMessageId: 'n1' });
  });

  it('normalises the header so <A@x> and a@x collide', async () => {
    const h = header();
    await dedupe.claim(`  ${h.toUpperCase()}  `, FROM, 'work', 'n1');
    const r = await dedupe.claim(h.slice(1, -1), FROM, 'personal', 'n2');
    expect(r).toEqual({ first: false, mailboxId: 'work', nylasMessageId: 'n1' });
  });

  it('two concurrent claims of one message: exactly one wins, the other names it (P5)', async () => {
    const h = header();
    const [a, b] = await Promise.all([
      dedupe.claim(h, FROM, 'work', 'n-work'),
      dedupe.claim(h, FROM, 'personal', 'n-personal'),
    ]);
    const results = [a, b];
    expect(results.filter((r) => r.first)).toHaveLength(1);
    const loser = results.find((r) => !r.first) as { first: false; mailboxId: string; nylasMessageId: string };
    const winnerMailbox = a.first ? 'work' : 'personal';
    expect(loser.mailboxId).toBe(winnerMailbox);
    expect(loser.nylasMessageId).toBe(winnerMailbox === 'work' ? 'n-work' : 'n-personal');
  });

  it('a reused Message-ID from another sender is not a duplicate (R54)', async () => {
    const h = header();
    await dedupe.claim(h, 'real@example.org', 'work', 'n1');
    expect(await dedupe.claim(h, 'spoof@example.org', 'personal', 'n2')).toEqual({ first: true });
    // The same sender still collides, case and spacing aside.
    expect(await dedupe.claim(h, '  REAL@example.org ', 'personal', 'n3')).toEqual({ first: false, mailboxId: 'work', nylasMessageId: 'n1' });
  });

  it('refuses an empty From address and claims nothing', async () => {
    await expect(dedupe.claim(header(), '  ', 'work', 'n1')).rejects.toThrow(/From/);
  });

  it('refuses an empty or whitespace header and claims nothing', async () => {
    await expect(dedupe.claim('', FROM, 'work', 'n1')).rejects.toThrow(/Message-ID/);
    await expect(dedupe.claim('  <> ', FROM, 'work', 'n1')).rejects.toThrow(/Message-ID/);
    const { rows } = await pool.query(`SELECT 1 FROM principal_mail_dedupe WHERE message_id_header = ''`);
    expect(rows).toHaveLength(0);
  });

  it('a claim after the 30-day retention expires wins as first, replacing the old row', async () => {
    const h = header();
    await dedupe.claim(h, FROM, 'work', 'n1');
    await pool.query(
      `UPDATE principal_mail_dedupe SET triaged_at = now() - interval '31 days' WHERE message_id_header = $1`,
      [h.slice(1, -1).toLowerCase()],
    );
    expect(await dedupe.claim(h, FROM, 'personal', 'n2')).toEqual({ first: true });
    expect(await dedupe.claim(h, FROM, 'work', 'n3')).toEqual({ first: false, mailboxId: 'personal', nylasMessageId: 'n2' });
  });

  it('sweep removes rows older than 30 days and keeps newer ones', async () => {
    const old = header();
    const fresh = header();
    await dedupe.claim(old, FROM, 'work', 'n1');
    await dedupe.claim(fresh, FROM, 'work', 'n2');
    await pool.query(
      `UPDATE principal_mail_dedupe SET triaged_at = now() - interval '31 days' WHERE message_id_header = $1`,
      [old.slice(1, -1).toLowerCase()],
    );
    expect(await dedupe.sweep()).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query<{ message_id_header: string }>(
      `SELECT message_id_header FROM principal_mail_dedupe WHERE message_id_header = ANY($1)`,
      [[old, fresh].map((h) => h.slice(1, -1).toLowerCase())],
    );
    expect(rows.map((r) => r.message_id_header)).toEqual([fresh.slice(1, -1).toLowerCase()]);
  });
});
