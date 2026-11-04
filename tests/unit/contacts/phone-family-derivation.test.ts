// Phone-family derivation (#2447): a verified, active E.164 number on one of phone /
// sms / signal is usable on the others for the same contact, as a derived row.

import { beforeEach, describe, expect, it } from 'vitest';
import { ContactService } from '../../../src/contacts/contact-service.js';
import {
  DERIVED_IDENTITY_SOURCE,
  deriveIdentity,
  derivationSources,
} from '../../../src/contacts/phone-family-derivation.js';
import type { Contact, LinkIdentityOptions } from '../../../src/contacts/types.js';

const NUMBER = '+14165550100';
const CHANNELS = ['phone', 'sms', 'signal'] as const;

describe('phone-family derivation', () => {
  let contacts: ContactService;
  let venue: Contact;

  beforeEach(async () => {
    contacts = ContactService.createInMemory();
    venue = await contacts.createContact({ displayName: 'Harbour Venue', source: 'ceo_stated' });
  });

  async function link(options: Partial<LinkIdentityOptions> & { channel: string }): Promise<void> {
    await contacts.linkIdentity({
      contactId: venue.id,
      channelIdentifier: NUMBER,
      source: 'agent_stated',
      verified: true,
      ...options,
    });
  }

  async function sourcesFor(channel: string, identifier?: string) {
    const found = (await contacts.getContactWithIdentities(venue.id))!;
    return derivationSources(found.contact, found.identities, channel, identifier);
  }

  for (const from of CHANNELS) {
    for (const to of CHANNELS) {
      if (from === to) continue;
      it(`derives ${to} from a verified ${from} number`, async () => {
        await link({ channel: from, label: 'front desk' });
        const [source] = await sourcesFor(to);
        expect(source).toMatchObject({ channel: from, channelIdentifier: NUMBER });

        const result = await deriveIdentity(contacts, { contact: venue, channel: to, source: source! });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.identity).toMatchObject({
          channel: to,
          channelIdentifier: NUMBER,
          source: DERIVED_IDENTITY_SOURCE,
          verified: true,
          status: 'active',
          label: 'front desk',
          derivedFromIdentityId: source!.id,
        });
        // A reply from the number on the derived channel now resolves to the same contact.
        expect((await contacts.resolveByChannelIdentity(to, NUMBER))?.contactId).toBe(venue.id);
      });
    }
  }

  it('refuses an unverified source', async () => {
    await link({ channel: 'sms', source: 'sms_participant', verified: false });
    expect(await sourcesFor('signal')).toEqual([]);
  });

  it('refuses an inactive source', async () => {
    await link({ channel: 'phone', status: 'bounced' });
    expect(await sourcesFor('sms')).toEqual([]);
  });

  it('refuses a Signal ACI-UUID source: it has no number', async () => {
    await link({
      channel: 'signal',
      channelIdentifier: '8d1f4c2e-5a6b-4c3d-9e8f-0a1b2c3d4e5f',
      source: 'signal_participant',
    });
    expect(await sourcesFor('sms')).toEqual([]);
  });

  it('refuses a structural contact', async () => {
    const agent = await contacts.createContact({ displayName: 'Curia', source: 'ceo_stated', kind: 'agent' });
    await contacts.linkIdentity({ contactId: agent.id, channel: 'phone', channelIdentifier: NUMBER, source: 'ceo_stated' });
    const found = (await contacts.getContactWithIdentities(agent.id))!;
    expect(derivationSources(found.contact, found.identities, 'sms')).toEqual([]);
  });

  it('refuses the principal', async () => {
    const created = await contacts.createContact({ displayName: 'The Principal', source: 'ceo_stated' });
    const principal = await contacts.saveContact({ ...created, systemRole: 'principal' });
    await contacts.linkIdentity({ contactId: principal.id, channel: 'signal', channelIdentifier: NUMBER, source: 'ceo_stated' });
    const found = (await contacts.getContactWithIdentities(principal.id))!;
    expect(derivationSources(found.contact, found.identities, 'sms')).toEqual([]);
  });

  it('applies only to phone-family channels', async () => {
    await link({ channel: 'phone' });
    expect(await sourcesFor('email')).toEqual([]);
    expect(await sourcesFor('slack')).toEqual([]);
  });

  it('skips a number that already has a row on the channel, whatever its state', async () => {
    await link({ channel: 'phone' });
    await link({ channel: 'sms', source: 'sms_participant', verified: false });
    expect(await sourcesFor('sms')).toEqual([]);
  });

  it('keeps only sources holding the given number', async () => {
    await link({ channel: 'phone' });
    expect(await sourcesFor('sms', '+1 (416) 555-0100')).toHaveLength(1);
    expect(await sourcesFor('sms', '+14165550199')).toEqual([]);
  });

  it('lists one source per number, oldest first', async () => {
    await link({ channel: 'phone' });
    await link({ channel: 'signal' });
    const sources = await sourcesFor('sms');
    expect(sources).toHaveLength(1);
    expect(sources[0]!.channel).toBe('phone');
  });

  it('a duplicate on a sibling channel of another contact is a candidate', async () => {
    await link({ channel: 'phone' });
    const other = await contacts.createContact({ displayName: 'Harbour Catering', source: 'ceo_stated' });
    await contacts.linkIdentity({ contactId: other.id, channel: 'signal', channelIdentifier: NUMBER, source: 'ceo_stated' });
    const [source] = await sourcesFor('sms');

    const refused = await deriveIdentity(contacts, { contact: venue, channel: 'sms', source: source! });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.check.taken).toEqual([]);
      expect(refused.check.candidates.map((c) => c.contact.id)).toEqual([other.id]);
      expect(refused.check.candidates[0]!.reasons).toEqual([{ kind: 'same_number', channel: 'signal' }]);
    }
    expect(await contacts.resolveByChannelIdentity('sms', NUMBER)).toBeNull();

    const accepted = await deriveIdentity(contacts, {
      contact: venue, channel: 'sms', source: source!, isDistinct: (c) => c.id === other.id,
    });
    expect(accepted.ok).toBe(true);
  });

  it('the number held on the same channel by another contact is taken', async () => {
    await link({ channel: 'phone' });
    const other = await contacts.createContact({ displayName: 'Harbour Catering', source: 'ceo_stated' });
    await contacts.linkIdentity({ contactId: other.id, channel: 'sms', channelIdentifier: NUMBER, source: 'ceo_stated' });
    const [source] = await sourcesFor('sms');

    const refused = await deriveIdentity(contacts, {
      contact: venue, channel: 'sms', source: source!, isDistinct: () => true,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.check.taken.map((t) => t.contact.id)).toEqual([other.id]);
  });

  it('a similar number on another contact does not block: this one is an exact copy', async () => {
    await link({ channel: 'phone' });
    const other = await contacts.createContact({ displayName: 'Harbour Catering', source: 'ceo_stated' });
    await contacts.linkIdentity({ contactId: other.id, channel: 'sms', channelIdentifier: '+14165550101', source: 'ceo_stated' });
    const [source] = await sourcesFor('sms');
    expect((await deriveIdentity(contacts, { contact: venue, channel: 'sms', source: source! })).ok).toBe(true);
  });
});

describe('ContactService.linkIdentity with derived rows', () => {
  it('requires derivedFromIdentityId on a derived row, and refuses it on any other', async () => {
    const contacts = ContactService.createInMemory();
    const contact = await contacts.createContact({ displayName: 'Harbour Venue', source: 'ceo_stated' });
    await expect(contacts.linkIdentity({
      contactId: contact.id, channel: 'sms', channelIdentifier: NUMBER, source: 'derived', verified: true,
    })).rejects.toThrow(/derivedFromIdentityId/);
    await expect(contacts.linkIdentity({
      contactId: contact.id, channel: 'sms', channelIdentifier: NUMBER, source: 'agent_stated', derivedFromIdentityId: 'x',
    })).rejects.toThrow(/derivedFromIdentityId/);
  });
});
