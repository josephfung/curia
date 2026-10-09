// Test fixture for the ceo-inbox draft tools' recipients (#2053): an in-memory contact
// store behind the real reference resolver, and a source lookup that knows a fixed set
// of addresses. Imported by handler tests only.

import { ContactService } from '../../src/contacts/contact-service.js';
import { resolveRecipientReference, type RecipientReferenceFields } from '../../src/skills/_shared/recipient-reference.js';
import type { IdentifierSources } from '../../src/contacts/identifier-provenance.js';
import type { ToolContext } from '../../src/skills/types.js';

export interface DraftRecipientFixture {
  contacts: ContactService;
  principalId: string;
  /** Verified, with a display name. */
  aliceId: string;
  /** Two verified addresses; the primary is work. */
  sanjayId: string;
  blockedId: string;
  /** Only an unverified address on file. */
  unverifiedId: string;
}

export async function seedDraftRecipients(): Promise<DraftRecipientFixture> {
  const contacts = ContactService.createInMemory();

  const principal = await contacts.createContact({ displayName: 'Pat Principal', source: 'ceo_stated', tier: 'known' });
  await contacts.linkIdentity({ contactId: principal.id, channel: 'email', channelIdentifier: 'pat@home.example', source: 'ceo_stated' });

  const alice = await contacts.createContact({ displayName: 'Alice Archer', source: 'ceo_stated', tier: 'known' });
  await contacts.linkIdentity({ contactId: alice.id, channel: 'email', channelIdentifier: 'alice@example.com', source: 'ceo_stated' });

  const sanjay = await contacts.createContact({ displayName: 'Sanjay Rao', source: 'ceo_stated', tier: 'known' });
  await contacts.linkIdentity({ contactId: sanjay.id, channel: 'email', channelIdentifier: 'sanjay@work.example', source: 'ceo_stated' });
  await contacts.linkIdentity({ contactId: sanjay.id, channel: 'email', channelIdentifier: 'sanjay@home.example', source: 'ceo_stated' });
  await contacts.updateContactFields(sanjay.id, { primaryEmail: 'sanjay@work.example' });

  const blocked = await contacts.createContact({ displayName: 'Blake Blocked', source: 'ceo_stated', tier: 'known' });
  await contacts.linkIdentity({ contactId: blocked.id, channel: 'email', channelIdentifier: 'blake@example.com', source: 'ceo_stated' });
  await contacts.setTier(blocked.id, 'blocked');

  const unverified = await contacts.createContact({ displayName: 'Uma Unverified', source: 'ceo_stated', tier: 'known' });
  await contacts.linkIdentity({
    contactId: unverified.id, channel: 'email', channelIdentifier: 'uma@example.com', source: 'outbound_recipient', verified: false,
  });

  return {
    contacts,
    principalId: principal.id,
    aliceId: alice.id,
    sanjayId: sanjay.id,
    blockedId: blocked.id,
    unverifiedId: unverified.id,
  };
}

/** A source lookup that finds exactly `addresses` (lowercased), as the runtime's index would. */
export function sourcesWith(...addresses: string[]): IdentifierSources {
  const known = new Set(addresses.map((address) => address.toLowerCase()));
  return { has: async (channel, identifier) => channel === 'email' && known.has(identifier.toLowerCase()) };
}

/** The ToolContext fields the execution layer sets for reference resolution and provenance. */
export function recipientContext(
  fixture: DraftRecipientFixture,
  sources: IdentifierSources = sourcesWith(),
): Pick<ToolContext, 'contactService' | 'resolveRecipientReference' | 'identifierSources'> {
  return {
    contactService: fixture.contacts,
    identifierSources: sources,
    resolveRecipientReference: (channel: string, value: string, fields: RecipientReferenceFields) =>
      resolveRecipientReference(value, channel, fields, {
        contactService: fixture.contacts,
        principalContactId: fixture.principalId,
      }),
  };
}
