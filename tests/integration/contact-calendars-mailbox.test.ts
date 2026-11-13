// contact_calendars.principal_mailbox_id (migration 126) and its boot backfill (#2475, Part 4).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { backfillCalendarMailboxes } from '../../src/principal-mailboxes/backfill-calendar-mailboxes.js';
import { createSilentLogger } from '../../src/logger.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env['DATABASE_URL'];
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('contact_calendars mailbox column', () => {
  let pool: pg.Pool;
  const suffix = randomBytes(3).toString('hex');
  const mbA = `cal-a-${suffix}`;
  const mbB = `cal-b-${suffix}`;
  const contactId = randomUUID();
  const calIds = (n: string) => `${n}-${suffix}`;

  const insert = (nylasId: string, mailbox: string | null, primary: boolean) =>
    pool.query(
      `INSERT INTO contact_calendars (id, nylas_calendar_id, contact_id, label, is_primary, principal_mailbox_id)
       VALUES ($1, $2, $3, 'L', $4, $5)`,
      [randomUUID(), nylasId, contactId, primary, mailbox],
    );

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    await pool.query(`INSERT INTO contacts (id, display_name) VALUES ($1, 'Cal Test')`, [contactId]);
    for (const [id, addr] of [[mbA, `a-${suffix}@example.com`], [mbB, `b-${suffix}@example.com`]] as const) {
      await pool.query(
        `INSERT INTO principal_mailboxes (id, label, address, provider, is_default) VALUES ($1, $1, $2, 'google', false)`,
        [id, addr],
      );
    }
  });

  afterAll(async () => {
    await pool.query('DELETE FROM contact_calendars WHERE contact_id = $1', [contactId]);
    // The backfill assigns every unassigned calendar in the table to mbA; release them first.
    await pool.query('UPDATE contact_calendars SET principal_mailbox_id = NULL WHERE principal_mailbox_id = ANY($1)', [[mbA, mbB]]);
    await pool.query('DELETE FROM principal_mailboxes WHERE id = ANY($1)', [[mbA, mbB]]);
    await pool.query('DELETE FROM contacts WHERE id = $1', [contactId]);
    await pool.end();
  });

  it('one primary per contact per mailbox', async () => {
    await insert(calIds('p1'), mbA, true);
    await insert(calIds('p2'), mbB, true);
    await expect(insert(calIds('p3'), mbA, true)).rejects.toMatchObject({ code: '23505' });
    // A mailbox-less primary is its own slot.
    await insert(calIds('p4'), null, true);
    await expect(insert(calIds('p5'), null, true)).rejects.toMatchObject({ code: '23505' });
  });

  it('nylas_calendar_id stays globally unique', async () => {
    await expect(insert(calIds('p1'), mbB, false)).rejects.toMatchObject({ code: '23505' });
  });

  it('backfill assigns the default mailbox once', async () => {
    await pool.query('DELETE FROM contact_calendars WHERE contact_id = $1', [contactId]);
    await insert(calIds('b1'), null, false);
    await insert(calIds('b2'), mbB, false);
    const log = createSilentLogger();
    const first = await backfillCalendarMailboxes(pool, mbA, log);
    expect(first).toBeGreaterThanOrEqual(1);
    const rows = await pool.query<{ nylas_calendar_id: string; principal_mailbox_id: string }>(
      'SELECT nylas_calendar_id, principal_mailbox_id FROM contact_calendars WHERE contact_id = $1', [contactId]);
    const byId = Object.fromEntries(rows.rows.map((r) => [r.nylas_calendar_id, r.principal_mailbox_id]));
    expect(byId[calIds('b1')]).toBe(mbA);
    expect(byId[calIds('b2')]).toBe(mbB); // already assigned: untouched
    expect(await backfillCalendarMailboxes(pool, mbA, log)).toBe(0);
  });

  it('backfill with no default mailbox skips', async () => {
    expect(await backfillCalendarMailboxes(pool, null, createSilentLogger())).toBe(0);
  });
});
