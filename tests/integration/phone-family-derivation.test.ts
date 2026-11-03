// Integration test — derived phone-family identities against a live Postgres (#2447).
//
// Covers what the in-memory backend cannot prove:
//   - migration 116's derived_from_identity_id column round-trips through the backend
//   - a derived send leaves an sms row, so an inbound SMS from the number resolves to
//     the same contact and creates no new one (the reason the resolver writes the row)
//   - the CHECK constraint and ON DELETE SET NULL on the new column
//
// Every fixture row is created by this suite and deleted by id in afterEach.
// Skips gracefully when DATABASE_URL is not set.

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import pg from 'pg';
import { randomInt } from 'node:crypto';
import { ContactService } from '../../src/contacts/contact-service.js';
import { createSilentLogger } from '../../src/logger.js';
import { resolveRecipientReference } from '../../src/skills/_shared/recipient-reference.js';

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
    contacts = ContactService.createWithPostgres(pool, undefined, createSilentLogger());
    // Fails fast when migration 116 has not been applied.
    await pool.query('SELECT derived_from_identity_id FROM contact_channel_identities LIMIT 0');
  });

  afterEach(async () => {
    if (createdContactIds.length > 0) {
      // Pick up any contact an inbound resolve created by mistake, so a failure leaves nothing behind.
      const stray = await contactsHolding(number);
      await pool.query(`DELETE FROM contact_channel_identities WHERE contact_id = ANY($1::uuid[])`, [[...createdContactIds, ...stray]]);
      await pool.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [[...createdContactIds, ...stray]]);
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
    expect(inbound).toMatchObject({ contactId: venue.id, created: false });
    expect(await contactsHolding(number)).toEqual([venue.id]);
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
