// contact_calendars.principal_mailbox_id (migration 126), its boot backfill, and the calendar
// registry reads that know about mailboxes (#2475, Part 4).
//
// The backfill is global (it assigns every unassigned calendar in the table), and integration
// files share one database. So assertions read only this file's own contacts' rows, and the
// cleanup releases exactly the rows this file's backfill assigned: the ones now on this file's
// own mailbox id, which nothing else uses.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { backfillCalendarMailboxes } from '../../src/principal-mailboxes/backfill-calendar-mailboxes.js';
import { ContactService } from '../../src/contacts/contact-service.js';
import { createSilentLogger } from '../../src/logger.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env['DATABASE_URL'];
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('contact_calendars mailbox column', () => {
  let pool: pg.Pool;
  let contacts: ContactService;
  const suffix = randomBytes(3).toString('hex');
  const mbA = `cal-a-${suffix}`;
  const mbB = `cal-b-${suffix}`;
  const contactId = randomUUID();
  const extraContacts: string[] = [];
  const calIds = (n: string) => `${n}-${suffix}`;

  const insert = (nylasId: string, mailbox: string | null, primary: boolean, owner: string = contactId) =>
    pool.query(
      `INSERT INTO contact_calendars (id, nylas_calendar_id, contact_id, label, is_primary, principal_mailbox_id)
       VALUES ($1, $2, $3, 'L', $4, $5)`,
      [randomUUID(), nylasId, owner, primary, mailbox],
    );

  const newContact = async (name: string): Promise<string> => {
    const id = randomUUID();
    await pool.query(`INSERT INTO contacts (id, display_name, kg_node_id) VALUES ($1, $2, NULL)`, [id, name]);
    extraContacts.push(id);
    return id;
  };

  /** This file's rows only: nylas id → { mailbox, primary }. */
  const ownRows = async (ids: string[]) => {
    const { rows } = await pool.query<{ nylas_calendar_id: string; principal_mailbox_id: string | null; is_primary: boolean; contact_id: string; updated_at: Date }>(
      `SELECT nylas_calendar_id, principal_mailbox_id, is_primary, contact_id, updated_at
       FROM contact_calendars WHERE contact_id = ANY($1::uuid[])`,
      [ids],
    );
    return Object.fromEntries(rows.map((r) => [r.nylas_calendar_id, r]));
  };

  // Teardown deletes only after the database was confirmed to be curia_test.
  let dbValidated = false;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    dbValidated = true;
    contacts = ContactService.createWithPostgres(pool, undefined, createSilentLogger());
    await pool.query(`INSERT INTO contacts (id, display_name) VALUES ($1, 'Cal Test')`, [contactId]);
    for (const [id, addr] of [[mbA, `a-${suffix}@example.com`], [mbB, `b-${suffix}@example.com`]] as const) {
      await pool.query(
        `INSERT INTO principal_mailboxes (id, label, address, provider, is_default) VALUES ($1, $1, $2, 'google', false)`,
        [id, addr],
      );
    }
  });

  afterAll(async () => {
    try {
      if (dbValidated) {
        const mine = [contactId, ...extraContacts];
        await pool.query('DELETE FROM contact_calendars WHERE contact_id = ANY($1::uuid[])', [mine]);
        // Rows of other files that this file's backfill assigned (only it uses mbA): release them.
        await pool.query('UPDATE contact_calendars SET principal_mailbox_id = NULL WHERE principal_mailbox_id = $1', [mbA]);
        await pool.query('DELETE FROM principal_mailboxes WHERE id = ANY($1)', [[mbA, mbB]]);
        await pool.query('DELETE FROM contacts WHERE id = ANY($1::uuid[])', [mine]);
      }
    } finally {
      await pool.end();
    }
  });

  // Each test starts from the same rows of this file's contact: primaries p1 (mbA), p2 (mbB) and
  // p4 (no mailbox), so any one test runs on its own.
  beforeEach(async () => {
    await pool.query('DELETE FROM contact_calendars WHERE contact_id = $1', [contactId]);
    await insert(calIds('p1'), mbA, true);
    await insert(calIds('p2'), mbB, true);
    await insert(calIds('p4'), null, true);
  });

  it('one primary per contact per mailbox', async () => {
    await expect(insert(calIds('p3'), mbA, true)).rejects.toMatchObject({ code: '23505' });
    // A mailbox-less primary is its own slot.
    await expect(insert(calIds('p5'), null, true)).rejects.toMatchObject({ code: '23505' });
  });

  it('nylas_calendar_id stays globally unique', async () => {
    await expect(insert(calIds('p1'), mbB, false)).rejects.toMatchObject({ code: '23505' });
  });

  it('getPrimaryCalendar picks the named mailbox, and otherwise a deterministic one', async () => {
    // From beforeEach: p1 (mbA), p2 (mbB) and p4 (no mailbox) are all primary.
    expect((await contacts.getPrimaryCalendar(contactId, mbB))?.nylasCalendarId).toBe(calIds('p2'));
    expect((await contacts.getPrimaryCalendar(contactId, mbA))?.nylasCalendarId).toBe(calIds('p1'));
    // Neither test mailbox is the default, so the oldest primary wins, every time.
    const first = await contacts.getPrimaryCalendar(contactId);
    expect(first?.nylasCalendarId).toBe(calIds('p1'));
    expect((await contacts.getPrimaryCalendar(contactId))?.nylasCalendarId).toBe(first?.nylasCalendarId);
  });

  it('getCalendarsForMailbox and setCalendarMailbox', async () => {
    expect((await contacts.getCalendarsForMailbox(mbB)).map((c) => c.nylasCalendarId)).toEqual([calIds('p2')]);
    // p4 is a primary with no mailbox; mbB already has p2 as this contact's primary.
    await expect(contacts.setCalendarMailbox(calIds('p4'), mbB)).rejects.toMatchObject({ code: '23505' });
    await insert(calIds('s1'), mbA, false);
    expect(await contacts.setCalendarMailbox(calIds('s1'), mbB)).toBe(true);
    expect((await contacts.resolveCalendar(calIds('s1')))?.principalMailboxId).toBe(mbB);
    expect(await contacts.setCalendarMailbox(calIds('nope'), mbB)).toBe(false);
  });

  it('a merge keeps primaries in two mailboxes and demotes one in the same mailbox', async () => {
    const survivor = await newContact('Merge Survivor');
    const merged = await newContact('Merge Secondary');
    await insert(calIds('m-s-a'), mbA, true, survivor);
    await insert(calIds('m-m-b'), mbB, true, merged); // another mailbox: stays primary
    await insert(calIds('m-m-a'), mbA, true, merged); // same mailbox as the survivor's: demoted
    await contacts.mergeContacts(survivor, merged);
    const rows = await ownRows([survivor, merged]);
    expect(rows[calIds('m-s-a')]).toMatchObject({ contact_id: survivor, is_primary: true });
    expect(rows[calIds('m-m-b')]).toMatchObject({ contact_id: survivor, is_primary: true });
    expect(rows[calIds('m-m-a')]).toMatchObject({ contact_id: survivor, is_primary: false });
  });

  it('backfill assigns the default mailbox once', async () => {
    await pool.query('DELETE FROM contact_calendars WHERE contact_id = $1', [contactId]);
    await insert(calIds('b1'), null, false);
    await insert(calIds('b2'), mbB, false);
    const log = createSilentLogger();
    await backfillCalendarMailboxes(pool, mbA, log);
    const after = await ownRows([contactId]);
    expect(after[calIds('b1')]?.principal_mailbox_id).toBe(mbA);
    expect(after[calIds('b2')]?.principal_mailbox_id).toBe(mbB); // already assigned: untouched
    // A second run leaves this file's rows alone (other files' new rows are theirs to count).
    await backfillCalendarMailboxes(pool, mbA, log);
    const again = await ownRows([contactId]);
    expect(again[calIds('b1')]?.updated_at.getTime()).toBe(after[calIds('b1')]?.updated_at.getTime());
    expect(again[calIds('b2')]?.updated_at.getTime()).toBe(after[calIds('b2')]?.updated_at.getTime());
  });

  it('backfill with no default mailbox skips', async () => {
    expect(await backfillCalendarMailboxes(pool, null, createSilentLogger())).toBe(0);
  });
});
