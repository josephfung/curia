// Integration test — derived phone-family identities against a live Postgres (#2447).
//
// Covers what the in-memory backend cannot prove:
//   - migration 116's derived_from_identity_id column round-trips through the backend
//   - a derived send leaves an sms row, so an inbound SMS from the number resolves to
//     the same contact and creates no new one (the reason the resolver writes the row)
//   - the CHECK constraint and ON DELETE SET NULL on the new column
//
// afterEach deletes only contacts this suite created, by id: each fixture contact, and
// any contact the inbound resolve returns, recorded before the assertions run. Another
// suite's rows are never swept, even one that happens to hold the same random number.
// Skips gracefully when DATABASE_URL is not set.

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import pg from 'pg';
import { randomInt } from 'node:crypto';
import { ContactService } from '../../src/contacts/contact-service.js';
import { createSilentLogger } from '../../src/logger.js';
import { resolveRecipientReference } from '../../src/skills/_shared/recipient-reference.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;

const DATABASE_URL = process.env['DATABASE_URL'];
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('phone-family derivation (migration 116)', () => {
  let pool: pg.Pool;
  let contacts: ContactService;
  const createdContactIds: string[] = [];

  // A number unlikely to collide with another fixture: the fictional 555 exchange, random line.
  const number = `+1416555${String(randomInt(0, 10_000)).padStart(4, '0')}`;

  async function contactsHolding(identifier: string): Promise<string[]> {
    const { rows } = await pool.query<{ contact_id: string }>(
      `SELECT DISTINCT contact_id FROM contact_channel_identities WHERE channel_identifier = $1`,
      [identifier],
    );
    return rows.map((row) => row.contact_id);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    contacts = ContactService.createWithPostgres(pool, undefined, createSilentLogger());
    // Fails fast when migration 116 has not been applied.
    await pool.query('SELECT derived_from_identity_id FROM contact_channel_identities LIMIT 0');
    const held = await contactsHolding(number);
    if (held.length > 0) throw new Error(`fixture number ${number} is already held by another suite; re-run`);
  });

  afterEach(async () => {
    if (createdContactIds.length > 0) {
      await pool.query(`DELETE FROM contact_channel_identities WHERE contact_id = ANY($1::uuid[])`, [createdContactIds]);
      await pool.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [createdContactIds]);
      createdContactIds.length = 0;
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('a derived sms send leaves a row an inbound SMS reply resolves to, with no new contact', async () => {
    const venue = await contacts.createContact({ displayName: 'Harbour Venue (itest-2447)', source: 'ceo_stated' });
    createdContactIds.push(venue.id);
    const phone = await contacts.linkIdentity({
      contactId: venue.id, channel: 'phone', channelIdentifier: number, source: 'agent_stated', verified: true,
    });

    const resolved = await resolveRecipientReference(venue.id, 'sms', { field: 'recipient' }, {
      contactService: contacts, principalContactId: undefined, deriver: contacts,
    });
    expect(resolved).toMatchObject({ ok: true, identifier: number, derivedFrom: 'phone' });

    const sms = (await contacts.getContactWithIdentities(venue.id))!.identities.find((i) => i.channel === 'sms');
    expect(sms).toMatchObject({ source: 'derived', verified: true, derivedFromIdentityId: phone.id });

    // The SMS adapter's inbound path (sms-adapter.ts → ensureChannelContact).
    const inbound = await contacts.ensureChannelContact({
      channel: 'sms', channelIdentifier: number, source: 'sms_participant', displayName: number,
    });
    // Recorded before asserting, so a wrongly created contact is still cleaned up.
    if (inbound.created) createdContactIds.push(inbound.contactId);
    expect(inbound).toMatchObject({ contactId: venue.id, created: false });
    expect(await contactsHolding(number)).toEqual([venue.id]);
  });

  it('defunct on the source row reaches its derived rows; bounced stays on the source', async () => {
    const venue = await contacts.createContact({ displayName: 'Harbour Venue (itest-2447)', source: 'ceo_stated' });
    createdContactIds.push(venue.id);
    const phone = await contacts.linkIdentity({
      contactId: venue.id, channel: 'phone', channelIdentifier: number, source: 'agent_stated', verified: true,
    });
    const sms = await contacts.linkIdentity({
      contactId: venue.id, channel: 'sms', channelIdentifier: number, source: 'derived', verified: true,
      derivedFromIdentityId: phone.id,
    });
    const statusOf = async (id: string): Promise<string | undefined> =>
      (await contacts.getContactWithIdentities(venue.id))!.identities.find((i) => i.id === id)?.status;

    expect(await contacts.setIdentityStatus(phone.id, 'bounced')).toMatchObject({ id: phone.id, status: 'bounced' });
    expect(await statusOf(sms.id)).toBe('active');

    expect(await contacts.setIdentityStatus(phone.id, 'defunct')).toMatchObject({ id: phone.id, status: 'defunct' });
    expect(await statusOf(sms.id)).toBe('defunct');

    expect(await contacts.setIdentityStatus(phone.id, 'active')).toMatchObject({ id: phone.id, status: 'active' });
    expect(await statusOf(sms.id)).toBe('active');
  });

  it('defunct and reactivation reach a row derived from a derived row', async () => {
    const venue = await contacts.createContact({ displayName: 'Harbour Venue (itest-2447)', source: 'ceo_stated' });
    createdContactIds.push(venue.id);
    const phone = await contacts.linkIdentity({
      contactId: venue.id, channel: 'phone', channelIdentifier: number, source: 'agent_stated', verified: true,
    });
    const sms = await contacts.linkIdentity({
      contactId: venue.id, channel: 'sms', channelIdentifier: number, source: 'derived', verified: true,
      derivedFromIdentityId: phone.id,
    });
    const signal = await contacts.linkIdentity({
      contactId: venue.id, channel: 'signal', channelIdentifier: number, source: 'derived', verified: true,
      derivedFromIdentityId: sms.id,
    });
    const statusOf = async (id: string): Promise<string | undefined> =>
      (await contacts.getContactWithIdentities(venue.id))!.identities.find((i) => i.id === id)?.status;

    await contacts.setIdentityStatus(phone.id, 'defunct');
    expect([await statusOf(sms.id), await statusOf(signal.id)]).toEqual(['defunct', 'defunct']);

    // A derived row may only name a source on its own contact, so propagation never
    // reaches another contact's rows.
    const other = await contacts.createContact({ displayName: 'Other Venue (itest-2447)', source: 'ceo_stated' });
    createdContactIds.push(other.id);
    await expect(contacts.linkIdentity({
      contactId: other.id, channel: 'sms', channelIdentifier: number, source: 'derived', verified: true,
      derivedFromIdentityId: phone.id,
    })).rejects.toThrow(/same contact/);
    await contacts.setIdentityStatus(phone.id, 'active');
    expect([await statusOf(sms.id), await statusOf(signal.id)]).toEqual(['active', 'active']);
  });

  it('reactivating the source leaves a bounced derived row bounced', async () => {
    const venue = await contacts.createContact({ displayName: 'Harbour Venue (itest-2447)', source: 'ceo_stated' });
    createdContactIds.push(venue.id);
    const phone = await contacts.linkIdentity({
      contactId: venue.id, channel: 'phone', channelIdentifier: number, source: 'agent_stated', verified: true,
    });
    const sms = await contacts.linkIdentity({
      contactId: venue.id, channel: 'sms', channelIdentifier: number, source: 'derived', verified: true,
      derivedFromIdentityId: phone.id,
    });
    await contacts.setIdentityStatus(sms.id, 'bounced');
    await contacts.setIdentityStatus(phone.id, 'active');
    const after = (await contacts.getContactWithIdentities(venue.id))!.identities.find((i) => i.id === sms.id);
    expect(after?.status).toBe('bounced');
  });

  it('only a derived row may name a source row, and deleting the source nulls the link', async () => {
    const venue = await contacts.createContact({ displayName: 'Harbour Venue (itest-2447)', source: 'ceo_stated' });
    createdContactIds.push(venue.id);
    const phone = await contacts.linkIdentity({
      contactId: venue.id, channel: 'phone', channelIdentifier: number, source: 'agent_stated', verified: true,
    });

    await expect(pool.query(
      `INSERT INTO contact_channel_identities (contact_id, channel, channel_identifier, verified, source, derived_from_identity_id)
       VALUES ($1, 'signal', $2, true, 'agent_stated', $3)`,
      [venue.id, number, phone.id],
    )).rejects.toThrow(/contact_channel_identities_derived_from_check/);

    const signal = await contacts.linkIdentity({
      contactId: venue.id, channel: 'signal', channelIdentifier: number, source: 'derived', verified: true,
      derivedFromIdentityId: phone.id,
    });
    await pool.query(`DELETE FROM contact_channel_identities WHERE id = $1`, [phone.id]);
    const after = (await contacts.getContactWithIdentities(venue.id))!.identities.find((i) => i.id === signal.id);
    expect(after).toMatchObject({ source: 'derived', derivedFromIdentityId: null });
  });
});
