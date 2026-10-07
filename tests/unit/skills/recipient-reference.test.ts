// Send-by-reference resolution (#2033). A reference names a contact; the address
// comes from that contact's verified, active identities on the channel.

import { describe, it, expect, beforeEach } from 'vitest';
import { ContactService } from '../../../src/contacts/contact-service.js';
import {
  PRINCIPAL_RECIPIENT_ALIAS,
  parseRecipientReference,
  resolveRecipientReference,
} from '../../../src/skills/_shared/recipient-reference.js';

const FIELDS = { field: 'to', rawField: 'to_address' };

describe('parseRecipientReference', () => {
  it('reads the principal alias, case and whitespace insensitive', () => {
    expect(parseRecipientReference('principal')).toEqual({ kind: 'principal' });
    expect(parseRecipientReference('  Principal ')).toEqual({ kind: 'principal' });
  });

  it('reads a contact UUID', () => {
    const id = '4fdfd02a-1466-46ca-b37b-13bb564fe3f0';
    expect(parseRecipientReference(` ${id} `)).toEqual({ kind: 'contact', contactId: id });
  });

  it('is null for addresses and other values', () => {
    expect(parseRecipientReference('joseph@example.com')).toBeNull();
    expect(parseRecipientReference('+14155552671')).toBeNull();
    expect(parseRecipientReference('U012ABCDEF')).toBeNull();
    expect(parseRecipientReference('the principal')).toBeNull();
    expect(parseRecipientReference('')).toBeNull();
  });
});

describe('resolveRecipientReference', () => {
  let contacts: ContactService;
  let principalId: string;

  beforeEach(async () => {
    contacts = ContactService.createInMemory();
    // Resolution never reads the tier; the alias maps through principalContactId.
    const principal = await contacts.createContact({ displayName: 'Pat Principal', source: 'ceo_stated', tier: 'known' });
    principalId = principal.id;
    await contacts.linkIdentity({ contactId: principalId, channel: 'email', channelIdentifier: 'pat@work.example', source: 'ceo_stated' });
    await contacts.linkIdentity({ contactId: principalId, channel: 'email', channelIdentifier: 'pat@home.example', source: 'ceo_stated' });
    await contacts.linkIdentity({ contactId: principalId, channel: 'signal', channelIdentifier: '+15195550100', source: 'ceo_stated' });
    await contacts.updateContactFields(principalId, { primaryEmail: 'pat@home.example' });
  });

  function deps(principalContactId: string | undefined = principalId) {
    return { contactService: contacts, principalContactId };
  }

  it('resolves the principal alias to the primary email', async () => {
    const result = await resolveRecipientReference(PRINCIPAL_RECIPIENT_ALIAS, 'email', FIELDS, deps());
    expect(result).toEqual({ ok: true, contactId: principalId, identifier: 'pat@home.example', displayName: 'Pat Principal' });
  });

  it('resolves the principal alias on another channel', async () => {
    const result = await resolveRecipientReference('principal', 'signal', FIELDS, deps());
    expect(result).toMatchObject({ ok: true, identifier: '+15195550100' });
  });

  it('fails closed when the principal has no verified identity on the channel', async () => {
    const result = await resolveRecipientReference('principal', 'slack', FIELDS, deps());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/principal has no verified, active slack address/i);
      expect(result.error).toMatch(/nothing was sent/i);
    }
  });

  it('fails closed when no principal is configured', async () => {
    // Not deps(undefined): a default parameter would swap the principal back in.
    const result = await resolveRecipientReference('principal', 'email', FIELDS, {
      contactService: contacts,
      principalContactId: undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no principal/i);
  });

  it('resolves a contact UUID to its only verified identity', async () => {
    const alex = await contacts.createContact({ displayName: 'Alex Vendor', source: 'ceo_stated', tier: 'known' });
    await contacts.linkIdentity({ contactId: alex.id, channel: 'email', channelIdentifier: 'alex@vendor.example', source: 'email_participant' });
    const result = await resolveRecipientReference(alex.id, 'email', FIELDS, deps());
    expect(result).toEqual({ ok: true, contactId: alex.id, identifier: 'alex@vendor.example', displayName: 'Alex Vendor' });
  });

  it('a mistyped UUID finds no contact and fails closed', async () => {
    const result = await resolveRecipientReference('00000000-0000-4000-8000-000000000000', 'email', FIELDS, deps());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/no contact has id 00000000-0000-4000-8000-000000000000/i);
      expect(result.error).toMatch(/nothing was sent/i);
    }
  });

  it('skips unverified and inactive identities', async () => {
    const sam = await contacts.createContact({ displayName: 'Sam Cold', source: 'outbound_recipient', tier: 'known' });
    // Not auto-verified: an agent typed it (#2033).
    await contacts.linkIdentity({ contactId: sam.id, channel: 'email', channelIdentifier: 'sam@cold.example', source: 'outbound_recipient' });
    await contacts.linkIdentity({ contactId: sam.id, channel: 'email', channelIdentifier: 'sam@old.example', source: 'email_participant', status: 'bounced' });
    const result = await resolveRecipientReference(sam.id, 'email', FIELDS, deps());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Sam Cold.*has no verified, active email address/);
      expect(result.error).toMatch(/unverified or inactive/);
      // The unverified address is not echoed back for the model to retype.
      expect(result.error).not.toContain('sam@cold.example');
    }
  });

  it('ignores a primary email that is not a verified, active identity', async () => {
    await contacts.linkIdentity({ contactId: principalId, channel: 'email', channelIdentifier: 'pat@typo.example', source: 'outbound_recipient' });
    await contacts.updateContactFields(principalId, { primaryEmail: 'pat@typo.example' });
    const result = await resolveRecipientReference('principal', 'email', FIELDS, deps());
    // Falls back to the oldest verified, active identity.
    expect(result).toMatchObject({ ok: true, identifier: 'pat@work.example' });
  });

  it('rejects an address in the reference field and points at the raw field', async () => {
    const result = await resolveRecipientReference('pat@home.example', 'email', FIELDS, deps());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/to takes a contact ID or "principal"/);
      expect(result.error).toMatch(/to_address/);
    }
  });

  it('names a copied template token instead of calling it a bad ID', async () => {
    const result = await resolveRecipientReference('${principal_contact_id}', 'email', FIELDS, deps());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Unresolved template placeholder in "to"/);
      expect(result.error).toMatch(/"principal"/);
    }
  });

  it('fails closed with the cause when the contact lookup throws', async () => {
    const boom = new Error('db down');
    const result = await resolveRecipientReference('principal', 'email', FIELDS, {
      contactService: { getContactWithIdentities: async () => { throw boom; } },
      principalContactId: principalId,
    });
    expect(result).toMatchObject({ ok: false, cause: boom });
    if (!result.ok) expect(result.error).toMatch(/nothing was sent/i);
  });
});
