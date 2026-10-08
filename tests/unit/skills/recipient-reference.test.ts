// Send-by-reference resolution (#2033). A reference names a contact; the address
// comes from that contact's verified, active identities on the channel.

import { describe, it, expect, beforeEach } from 'vitest';
import { ContactService } from '../../../src/contacts/contact-service.js';
import {
  PRINCIPAL_RECIPIENT_ALIAS,
  RECIPIENT_REFERENCE_SKILLS,
  findRetiredRecipientField,
  formatResolvedRecipient,
  parseRecipientReference,
  resolveRecipientReference,
  retiredRecipientFieldError,
  sendPinsMatch,
  type SendRecipientPin,
} from '../../../src/skills/_shared/recipient-reference.js';

const FIELDS = { field: 'to' };

describe('parseRecipientReference', () => {
  it('reads the principal alias, case and whitespace insensitive', () => {
    expect(parseRecipientReference('principal')).toEqual({ kind: 'principal' });
    expect(parseRecipientReference('  Principal ')).toEqual({ kind: 'principal' });
  });

  it('reads a contact UUID', () => {
    const id = '4fdfd02a-1466-46ca-b37b-13bb564fe3f0';
    expect(parseRecipientReference(` ${id} `)).toEqual({ kind: 'contact', contactId: id });
  });

  it('reads a label hint after #, and a blank hint is no hint', () => {
    const id = '4fdfd02a-1466-46ca-b37b-13bb564fe3f0';
    expect(parseRecipientReference('  Principal # Personal ')).toEqual({ kind: 'principal', label: 'Personal' });
    expect(parseRecipientReference(`${id}#work email`)).toEqual({ kind: 'contact', contactId: id, label: 'work email' });
    expect(parseRecipientReference('principal#')).toEqual({ kind: 'principal' });
    expect(parseRecipientReference('principal#   ')).toEqual({ kind: 'principal' });
  });

  it('is null for addresses and other values', () => {
    expect(parseRecipientReference('joseph@example.com')).toBeNull();
    expect(parseRecipientReference('+14155552671')).toBeNull();
    expect(parseRecipientReference('U012ABCDEF')).toBeNull();
    expect(parseRecipientReference('the principal')).toBeNull();
    expect(parseRecipientReference('')).toBeNull();
    // A `#` does not make an address a reference. The left side has to be one,
    // and a hint shaped like an address or a phone number is not a hint: an
    // email local-part may contain `#`.
    expect(parseRecipientReference('user#tag@example.com')).toBeNull();
    expect(parseRecipientReference('+1415555#2671')).toBeNull();
    expect(parseRecipientReference('principal#ops@vendor.example')).toBeNull();
    expect(parseRecipientReference('4fdfd02a-1466-46ca-b37b-13bb564fe3f0#someone.else@other.test')).toBeNull();
    expect(parseRecipientReference('principal#15551234567')).toBeNull();
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
    expect(result).toEqual({
      ok: true,
      kind: 'principal',
      contactId: principalId,
      identifier: 'pat@home.example',
      displayName: 'Pat Principal',
      identityName: 'primary',
      identityId: expect.any(String),
    });
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
    expect(result).toEqual({
      ok: true,
      kind: 'contact',
      contactId: alex.id,
      identifier: 'alex@vendor.example',
      displayName: 'Alex Vendor',
      identityName: 'unlabelled',
      identityId: expect.any(String),
    });
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
      expect(result.error).toMatch(/unverified, inactive/);
      // The unverified address is not echoed back for the model to retype.
      expect(result.error).not.toContain('sam@cold.example');
    }
  });

  it('refuses a blocked contact, since the gateway checks only the To tier (cc would get through)', async () => {
    const blocked = await contacts.createContact({ displayName: 'Blocked Person', source: 'ceo_stated', tier: 'blocked' });
    await contacts.linkIdentity({ contactId: blocked.id, channel: 'email', channelIdentifier: 'blocked@x.example', source: 'ceo_stated' });
    const result = await resolveRecipientReference(blocked.id, 'email', FIELDS, deps());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/is blocked\. Nothing was sent/);
  });

  // The gateway names a contact after its identifier. An error that quoted that name
  // would hand the model the stored number to re-state (#2041).
  it('never quotes a gateway-made contact named after its number', async () => {
    const texted = await contacts.createContact({ displayName: '+14165550100', source: 'outbound_recipient', tier: 'known' });
    await contacts.linkIdentity({ contactId: texted.id, channel: 'sms', channelIdentifier: '+14165550100', source: 'outbound_recipient' });
    const result = await resolveRecipientReference(texted.id, 'sms', FIELDS, deps());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/has no verified, active sms address/);
      expect(result.error).toContain(`Contact ${texted.id}`);
      expect(result.error).not.toContain('4165550100');
    }
  });

  it('never quotes an address-shaped name on a blocked contact', async () => {
    const blocked = await contacts.createContact({ displayName: 'spam@x.example', source: 'outbound_recipient', tier: 'blocked' });
    await contacts.linkIdentity({ contactId: blocked.id, channel: 'email', channelIdentifier: 'spam@x.example', source: 'ceo_stated' });
    const result = await resolveRecipientReference(blocked.id, 'email', FIELDS, deps());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(`Contact ${blocked.id} is blocked. Nothing was sent.`);
    }
  });

  it('skips a verified identity the channel cannot send to, so it does not shadow a sendable one', async () => {
    const sam = await contacts.createContact({ displayName: 'Sam Signal', source: 'ceo_stated', tier: 'known' });
    // A Signal ACI UUID recorded when an inbound message carried no number, oldest first.
    await contacts.linkIdentity({ contactId: sam.id, channel: 'signal', channelIdentifier: '9f1c2d3e-aaaa-4bbb-8ccc-123456789abc', source: 'signal_participant' });
    await contacts.linkIdentity({ contactId: sam.id, channel: 'signal', channelIdentifier: '+15195550123', source: 'signal_participant' });
    const result = await resolveRecipientReference(sam.id, 'signal', FIELDS, deps());
    expect(result).toMatchObject({ ok: true, identifier: '+15195550123' });
  });

  it('ignores a primary email that is not a verified, active identity', async () => {
    await contacts.linkIdentity({ contactId: principalId, channel: 'email', channelIdentifier: 'pat@typo.example', source: 'outbound_recipient' });
    await contacts.updateContactFields(principalId, { primaryEmail: 'pat@typo.example' });
    const result = await resolveRecipientReference('principal', 'email', FIELDS, deps());
    // Falls back to the oldest verified, active identity.
    expect(result).toMatchObject({ ok: true, identifier: 'pat@work.example' });
  });

  it('rejects an address in the reference field and points at contact-create', async () => {
    const result = await resolveRecipientReference('pat@home.example', 'email', FIELDS, deps());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/to takes a contact ID or "principal"/);
      expect(result.error).toMatch(/contact-create/);
      expect(result.error).not.toMatch(/to_address/);
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

describe('label hint (#2047)', () => {
  let contacts: ContactService;

  beforeEach(() => {
    contacts = ContactService.createInMemory();
  });

  function deps(principalContactId?: string) {
    return { contactService: contacts, principalContactId };
  }

  async function addContact(
    rows: Array<{ address: string; label?: string; channel?: string }>,
    options?: { primaryEmail?: string; primaryPhone?: string; name?: string },
  ) {
    const contact = await contacts.createContact({
      displayName: options?.name ?? 'Pat Vendor',
      source: 'ceo_stated',
      tier: 'known',
    });
    for (const row of rows) {
      await contacts.linkIdentity({
        contactId: contact.id,
        channel: row.channel ?? 'email',
        channelIdentifier: row.address,
        ...(row.label ? { label: row.label } : {}),
        source: 'ceo_stated',
      });
    }
    if (options?.primaryEmail || options?.primaryPhone) {
      await contacts.updateContactFields(contact.id, {
        ...(options.primaryEmail ? { primaryEmail: options.primaryEmail } : {}),
        ...(options.primaryPhone ? { primaryPhone: options.primaryPhone } : {}),
      });
    }
    return contact;
  }

  /** The first quoted label in the candidate list — what a retry should pass. */
  function listedLabel(error: string): string | undefined {
    const candidates = error.split('Candidates:')[1] ?? '';
    return candidates.match(/"((?:\\.|[^"\\])*)"/)?.[1];
  }

  it('with no hint, still uses the primary, otherwise the oldest', async () => {
    const pat = await addContact(
      [{ address: 'pat.work@hint.test', label: 'work' }, { address: 'pat.home@hint.test', label: 'personal' }],
      { primaryEmail: 'pat.home@hint.test' },
    );
    const hinted = await resolveRecipientReference(pat.id, 'email', FIELDS, deps());
    expect(hinted).toMatchObject({ ok: true, identifier: 'pat.home@hint.test', identityName: 'personal' });

    const unlabelled = await addContact([
      { address: 'old@hint.test' },
      { address: 'new@hint.test' },
    ]);
    const oldest = await resolveRecipientReference(unlabelled.id, 'email', FIELDS, deps());
    expect(oldest).toMatchObject({ ok: true, identifier: 'old@hint.test', identityName: 'unlabelled' });
  });

  it('sends to the one identity the hint matches, and names that label', async () => {
    const pat = await addContact(
      [
        { address: 'pat.work@hint.test', label: 'work' },
        { address: 'pat.home@hint.test', label: 'personal' },
      ],
      { primaryEmail: 'pat.work@hint.test' },
    );
    const result = await resolveRecipientReference(`${pat.id}# Personal `, 'email', FIELDS, deps());
    expect(result).toMatchObject({ ok: true, identifier: 'pat.home@hint.test', identityName: 'personal' });
  });

  it('matches a token of the label, so work selects work email and not homework', async () => {
    const pat = await addContact(
      [{ address: 'pat.work@hint.test', label: 'work email' }, { address: 'pat.home@hint.test', label: 'homework' }],
      { primaryEmail: 'pat.home@hint.test' },
    );
    const result = await resolveRecipientReference(`${pat.id}#work`, 'email', FIELDS, deps());
    expect(result).toMatchObject({ ok: true, identifier: 'pat.work@hint.test', identityName: 'work email' });
  });

  it('prefers one exact match over a token match', async () => {
    const pat = await addContact(
      [{ address: 'pat.email@hint.test', label: 'work email' }, { address: 'pat.work@hint.test', label: 'work' }],
      { primaryEmail: 'pat.email@hint.test' },
    );
    const result = await resolveRecipientReference(`${pat.id}#WORK`, 'email', FIELDS, deps());
    expect(result).toMatchObject({ ok: true, identifier: 'pat.work@hint.test', identityName: 'work' });
  });

  it('sends to the default when a hint is given and no address is labelled', async () => {
    const pat = await addContact(
      [{ address: 'only@hint.test' }],
      { primaryEmail: 'only@hint.test' },
    );
    const result = await resolveRecipientReference(`${pat.id}#personal`, 'email', FIELDS, deps());
    expect(result).toMatchObject({ ok: true, identifier: 'only@hint.test', identityName: 'primary' });
  });

  it('treats an address stuffed into a label as unlabelled, so a single such address still sends', async () => {
    const pat = await addContact(
      [{ address: 'only@hint.test', label: 'alt: hidden@secret.test' }],
      { primaryEmail: 'only@hint.test' },
    );
    const result = await resolveRecipientReference(`${pat.id}#personal`, 'email', FIELDS, deps());
    expect(result).toMatchObject({ ok: true, identifier: 'only@hint.test', identityName: 'primary' });
  });

  it('does not treat an address-shaped hint as a reference', async () => {
    const pat = await addContact(
      [{ address: 'only@hint.test' }],
      { primaryEmail: 'only@hint.test' },
    );
    const typed = `${pat.id}#someone.else@other.test`;
    const result = await resolveRecipientReference(typed, 'email', FIELDS, deps());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/contact-create/);
      // The error quotes the model's own input. It does not reveal a stored address.
      expect(result.error).toContain('someone.else@other.test');
      expect(result.error).not.toContain('only@hint.test');
    }
  });

  it('conflicts when a hint is given and more than one address is unlabelled', async () => {
    const pat = await addContact(
      [{ address: 'a@x.test' }, { address: 'b@x.test' }],
      { primaryEmail: 'a@x.test' },
    );
    const result = await resolveRecipientReference(`${pat.id}#personal`, 'email', FIELDS, deps());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/unlabelled \[primary\], unlabelled/);
      expect(result.error).toMatch(/Omit the label to use the primary/);
      expect(result.error).not.toContain('a@x.test');
      expect(result.error).not.toContain('b@x.test');
    }
  });

  it('conflicts when labelled addresses exist and the hint matches none, including an unlabelled one', async () => {
    const pat = await addContact(
      [
        { address: 'pat.home@hint.test', label: 'personal' },
        { address: 'pat.work@hint.test', label: 'work' },
        { address: 'pat.other@hint.test' },
      ],
      { primaryEmail: 'pat.work@hint.test', name: 'named@address.test' },
    );
    const result = await resolveRecipientReference(`${pat.id}#office`, 'email', FIELDS, deps());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/does not identify exactly one/);
      expect(result.error).toMatch(/"personal"/);
      expect(result.error).toMatch(/"work" \[primary\]/);
      expect(result.error).toMatch(/unlabelled/);
      expect(result.error).toMatch(/omit the label to use the primary/);
      expect(result.error).toContain(pat.id);
      for (const secret of ['pat.home@hint.test', 'pat.work@hint.test', 'pat.other@hint.test', 'named@address.test']) {
        expect(result.error).not.toContain(secret);
      }
    }
  });

  it('conflicts when more than one address matches, and an address-shaped hint is not a reference', async () => {
    const pat = await addContact(
      [
        { address: 'pat.email@hint.test', label: 'work email' },
        { address: 'pat.phone@hint.test', label: 'work phone' },
        { address: 'pat.hidden@hint.test', label: 'also hidden@secret.test' },
      ],
      { primaryEmail: 'pat.email@hint.test' },
    );
    const many = await resolveRecipientReference(`${pat.id}#work`, 'email', FIELDS, deps());
    expect(many.ok).toBe(false);
    if (!many.ok) {
      expect(many.error).toMatch(/"work email" \[primary\]/);
      expect(many.error).toMatch(/"work phone"/);
      expect(many.error).toMatch(/unlabelled/);
      expect(many.error).not.toContain('hidden@secret.test');
      expect(many.error).not.toContain('pat.email@hint.test');
    }

    const typed = `${pat.id}#pat.email@hint.test`;
    const hintedAddress = await resolveRecipientReference(typed, 'email', FIELDS, deps());
    expect(hintedAddress.ok).toBe(false);
    if (!hintedAddress.ok) {
      expect(hintedAddress.error).toMatch(/contact-create/);
      // The typed string is the model's own input, so it may appear. A stored
      // address-shaped label must not.
      expect(hintedAddress.error).not.toContain('hidden@secret.test');
    }
  });

  it('matches the full label and the 40-character form the principal block shows', async () => {
    const full = 'Personal Gmail used for family and school stuff';
    const shown = full.slice(0, 40);
    expect(shown.endsWith('schoo')).toBe(true);
    const pat = await addContact(
      [
        { address: 'pat.home@hint.test', label: full },
        { address: 'pat.work@hint.test', label: 'work' },
      ],
      { primaryEmail: 'pat.work@hint.test' },
    );
    const exact = await resolveRecipientReference(`${pat.id}#${full}`, 'email', FIELDS, deps());
    expect(exact).toMatchObject({ ok: true, identifier: 'pat.home@hint.test', identityName: full });

    const fromBlock = await resolveRecipientReference(`${pat.id}#${shown}`, 'email', FIELDS, deps());
    expect(fromBlock).toMatchObject({ ok: true, identifier: 'pat.home@hint.test', identityName: full });

    // "school" is past the 40-character cut, so a token match has to use the full label.
    const token = await resolveRecipientReference(`${pat.id}#school`, 'email', FIELDS, deps());
    expect(token).toMatchObject({ ok: true, identifier: 'pat.home@hint.test', identityName: full });
  });

  it('a hinted approval pin no longer matches after that identity is removed', async () => {
    const personal = { address: 'pat.home@hint.test', label: 'personal' };
    const other = { address: 'pat.other@hint.test' };
    const pat = await addContact([personal, other], { primaryEmail: 'pat.home@hint.test' });
    const ref = `${pat.id}#personal`;
    const first = await resolveRecipientReference(ref, 'email', FIELDS, deps());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const approved: SendRecipientPin = {
      ref,
      identityId: first.identityId,
      identityName: first.identityName,
    };
    expect(approved.identityName).toBe('personal');

    await contacts.unlinkIdentity(first.identityId);
    const later = await resolveRecipientReference(ref, 'email', FIELDS, deps());
    // The only address left is unlabelled, so a fresh hint falls back to it.
    expect(later).toMatchObject({ ok: true, identifier: 'pat.other@hint.test', identityName: 'unlabelled' });
    if (!later.ok) return;
    expect(sendPinsMatch(
      [{ ref, identityId: later.identityId, identityName: later.identityName }],
      [approved],
    )).toBe(false);
  });

  it('quotes the full label in a conflict, not the 40-character cut', async () => {
    const full = 'Personal Gmail used for family and school stuff';
    const pat = await addContact(
      [
        { address: 'pat.home@hint.test', label: full },
        { address: 'pat.work@hint.test', label: 'work' },
      ],
      { primaryEmail: 'pat.work@hint.test' },
    );
    const result = await resolveRecipientReference(`${pat.id}#office`, 'email', FIELDS, deps());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(`"${full}"`);
      expect(result.error).not.toContain('"Personal Gmail used for family and schoo"');
    }
  });

  it('a retry with a label listed in the conflict error succeeds', async () => {
    const pat = await addContact(
      [
        { address: 'pat.home@hint.test', label: 'personal' },
        { address: 'pat.work@hint.test', label: 'work email' },
      ],
      { primaryEmail: 'pat.work@hint.test' },
    );
    const failed = await resolveRecipientReference(`${pat.id}#office`, 'email', FIELDS, deps());
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    const label = listedLabel(failed.error);
    expect(label).toBe('personal');
    const retry = await resolveRecipientReference(`${pat.id}#${label}`, 'email', FIELDS, deps());
    expect(retry).toMatchObject({ ok: true, identifier: 'pat.home@hint.test', identityName: 'personal' });
  });

  it('a principal conflict names labels and not the contact id or any address', async () => {
    const principal = await addContact(
      [
        { address: 'pat.work@hint.test', label: 'work' },
        { address: 'pat.home@hint.test', label: 'personal' },
      ],
      { primaryEmail: 'pat.work@hint.test', name: 'Pat Principal' },
    );
    const result = await resolveRecipientReference('principal#office', 'email', FIELDS, deps(principal.id));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/The principal/);
      expect(result.error).toMatch(/principal#work/);
      expect(result.error).toMatch(/omit the label to use the primary/);
      expect(result.error).not.toContain(principal.id);
      expect(result.error).not.toContain('pat.work@hint.test');
      expect(result.error).not.toContain('pat.home@hint.test');
    }
  });
});

describe('formatResolvedRecipient', () => {
  it('puts the verified address first and the contact name after it', () => {
    expect(formatResolvedRecipient({ identifier: 'dana@example.com', displayName: 'Dana Lee' }))
      .toBe('dana@example.com (contact "Dana Lee")');
  });

  it('strips an address-shaped or reordering display name so it cannot pass for the address', () => {
    const shown = formatResolvedRecipient({
      identifier: 'attacker@evil.example',
      displayName: 'Pat <pat@home.example>\u202E"\n',
    });
    expect(shown.startsWith('attacker@evil.example')).toBe(true);
    expect(shown).not.toMatch(/[<>\u202E]/);
    expect(shown).not.toContain('pat@home.example');
  });

  it('shows just the address when the name is the address', () => {
    expect(formatResolvedRecipient({ identifier: 'new@cold.example', displayName: 'new@cold.example' }))
      .toBe('new@cold.example');
  });
});

describe('retired raw-address inputs (#2041)', () => {
  const email = RECIPIENT_REFERENCE_SKILLS['email-send']!;

  it('finds a present retired input and ignores blank ones (Review Focus 1)', () => {
    expect(findRetiredRecipientField(email, { to: 'principal', cc_addresses: 'ops@example.com' })).toBe('cc_addresses');
    expect(findRetiredRecipientField(email, { to: 'principal', to_address: '', cc_addresses: '  ' })).toBeNull();
    expect(findRetiredRecipientField(email, { to_address: null, cc_addresses: [] })).toBeNull();
    expect(findRetiredRecipientField(RECIPIENT_REFERENCE_SKILLS['signal-send']!, { recipient_number: 15551234567 })).toBe('recipient_number');
  });

  it('names the input that replaced it and contact-create', () => {
    const message = retiredRecipientFieldError(email, 'cc_addresses');
    expect(message).toMatch(/^cc_addresses is no longer accepted/);
    expect(message).toMatch(/contact ID in cc/);
    expect(message).toMatch(/contact-create/);
    expect(message).toMatch(/Nothing was sent\.$/);
  });

  it('covers the send skills and email-draft-save', () => {
    expect(Object.keys(RECIPIENT_REFERENCE_SKILLS).sort()).toEqual(['email-draft-save', 'email-send', 'signal-send', 'slack-send', 'sms-send']);
  });
});
