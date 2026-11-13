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
import { createMailboxCalendarHooks } from '../../src/principal-mailboxes/calendar-hooks.js';
import { registerMissingHomeCalendars } from '../../src/principal-mailboxes/register-home-calendars.js';
import { PrincipalMailboxStore } from '../../src/principal-mailboxes/store.js';
import { RemovedMailboxError, UnknownMailboxError } from '../../src/principal-mailboxes/types.js';
import { CalendarRouter } from '../../src/channels/calendar/calendar-router.js';
import { EntityContextAssembler } from '../../src/entity-context/assembler.js';
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
    expect(await backfillCalendarMailboxes(pool, null, createSilentLogger())).toEqual({ updated: 0, skipped: 0 });
  });

  it('backfill skips a primary that would collide with the default\'s, and still assigns the rest (SF-M6)', async () => {
    const who = await newContact('Backfill Collide');
    await insert(calIds('c-def'), mbA, true, who); // the contact's primary under the default
    await insert(calIds('c-null'), null, true, who); // a mailbox-less primary: would collide
    await insert(calIds('c-other'), null, false, who);
    const r = await backfillCalendarMailboxes(pool, mbA, createSilentLogger());
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    const rows = await ownRows([who]);
    expect(rows[calIds('c-null')]?.principal_mailbox_id).toBeNull();
    expect(rows[calIds('c-other')]?.principal_mailbox_id).toBe(mbA);
  });

  it('the boot catch-up registers a missing home calendar, and the router finds homes over real SQL, removed ones as removed (R103, m9)', async () => {
    const principal = await newContact('Catch-up Principal');
    const mbC = `cal-c-${suffix}`;
    const mbGone = `cal-g-${suffix}`;
    await pool.query(
      `INSERT INTO principal_mailboxes (id, label, address, provider, is_default, removed_at) VALUES
         ($1, 'C', $2, 'google', false, NULL), ($3, 'Gone', $4, 'google', false, now())`,
      [mbC, `c-${suffix}@example.com`, mbGone, `g-${suffix}@example.com`],
    );
    try {
      // The removed mailbox's home row stays (R75); mbB already has a home; mbC has none.
      await insert(calIds('h-gone'), mbGone, true, principal);
      await insert(calIds('h-b'), mbB, true, principal);
      const homeC = calIds('h-c');
      const hooks = createMailboxCalendarHooks({
        contacts,
        principalContactId: principal,
        calendarClient: async (id) => ({
          listCalendars: async () => [{ id: id === mbC ? homeC : `${id}-primary`, name: 'P', description: '', timezone: 'UTC', isPrimary: true, readOnly: false, isOwnedByUser: true }],
        }),
        logger: createSilentLogger(),
      });
      const live = [{ id: mbB, label: 'B' }, { id: mbC, label: 'C' }];
      const deps = {
        liveMailboxes: async () => live,
        hasHome: async (id: string) => (await contacts.getPrimaryCalendar(principal, id)) !== null,
        registerHome: hooks.registerHome,
        logger: createSilentLogger(),
      };
      expect(await registerMissingHomeCalendars(deps)).toEqual({ registered: 1, failed: 0 });
      expect((await contacts.getPrimaryCalendar(principal, mbC))?.nylasCalendarId).toBe(homeC);
      // Idempotent: a second run registers nothing.
      expect(await registerMissingHomeCalendars(deps)).toEqual({ registered: 0, failed: 0 });

      const store = new PrincipalMailboxStore(pool, createSilentLogger());
      const router = new CalendarRouter({
        mailboxes: {
          list: async () => live.map((m) => ({ ...m, address: '', isDefault: m.id === mbB, triageStartAt: null })),
          get: async (id) => {
            const row = await store.getAny(id);
            if (!row) throw new UnknownMailboxError(id);
            if (row.removedAt) throw new RemovedMailboxError(id, row.label);
            return { id, label: row.label, address: '', isDefault: false, triageStartAt: null };
          },
          isFallbackActive: async () => false,
          calendarClient: async () => ({ listCalendars: async () => [] }) as never,
          evidence: async () => [],
        },
        contacts,
        principalContactId: principal,
        logger: createSilentLogger(),
      });
      const homes = await router.homeCalendars();
      expect(homes.found.map((h) => [h.mailboxId, h.calendarId])).toEqual([[mbB, calIds('h-b')], [mbC, homeC]]);
      expect(homes.failures).toEqual([]);
      expect(homes.removed).toEqual([{ mailboxId: mbGone, calendarId: calIds('h-gone'), label: 'Gone' }]);

      // entity-context marks a removed mailbox's calendar, so it is not used as a live one (R104).
      const assembler = new EntityContextAssembler(pool, createSilentLogger());
      const accounts = await (assembler as unknown as { getConnectedAccounts(id: string): Promise<Array<{ serviceId: string; metadata: Record<string, unknown> }>> })
        .getConnectedAccounts(principal);
      const meta = Object.fromEntries(accounts.map((a) => [a.serviceId, a.metadata]));
      expect(meta[calIds('h-gone')]).toMatchObject({ mailboxId: mbGone, mailboxRemoved: true });
      expect(meta[calIds('h-b')]).toEqual({ mailboxId: mbB });
    } finally {
      await pool.query('DELETE FROM contact_calendars WHERE contact_id = $1', [principal]);
      await pool.query('DELETE FROM principal_mailboxes WHERE id = ANY($1)', [[mbC, mbGone]]);
    }
  });
});
