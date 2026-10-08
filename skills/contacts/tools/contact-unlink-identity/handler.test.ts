// contact-unlink-identity: agents cannot remove a structural contact's identities (#2041).

import { describe, it, expect, beforeEach } from 'vitest';
import pino from 'pino';
import { ContactUnlinkIdentityHandler } from './handler.js';
import { ContactService } from '../../../../src/contacts/contact-service.js';
import type { ChannelIdentity, Contact } from '../../../../src/contacts/types.js';
import type { ToolContext } from '../../../../src/skills/types.js';

const silentLog = pino({ level: 'silent' });

describe('ContactUnlinkIdentityHandler', () => {
  const handler = new ContactUnlinkIdentityHandler();
  let contacts: ContactService;

  function ctxFor(input: Record<string, unknown>): ToolContext {
    return { input, secret: () => 'unused', log: silentLog, contactService: contacts } as unknown as ToolContext;
  }

  async function contactWithEmail(fields: Partial<Contact>): Promise<{ contact: Contact; identity: ChannelIdentity }> {
    const contact = await contacts.createContact({ displayName: 'Pat Principal', source: 'ceo_stated' });
    await contacts.saveContact({ ...contact, ...fields });
    const identity = await contacts.linkIdentity({
      contactId: contact.id, channel: 'email', channelIdentifier: 'pat@home.example', source: 'ceo_stated',
    });
    return { contact, identity };
  }

  beforeEach(() => {
    contacts = ContactService.createInMemory();
  });

  it("refuses the principal's identity, changing nothing and naming no contact", async () => {
    const { contact, identity } = await contactWithEmail({ systemRole: 'principal' });
    const result = await handler.execute(ctxFor({ contact_id: contact.id, identity_id: identity.id }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("The principal's addresses are managed by the principal, in the console. Nothing was changed.");
      expect(result.error).not.toContain(contact.id);
    }
    expect(await contacts.getIdentity(identity.id)).not.toBeNull();
  });

  it.each([
    ['an agent system role', { systemRole: 'agent' }],
    ['tier principal and no system role', { tier: 'principal' }],
  ] as const)("refuses the identity of a contact with %s", async (_label, fields) => {
    const { contact, identity } = await contactWithEmail(fields);
    const result = await handler.execute(ctxFor({ contact_id: contact.id, identity_id: identity.id }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('This is a system contact; its addresses are not managed by agents. Nothing was changed.');
    }
    expect(await contacts.getIdentity(identity.id)).not.toBeNull();
  });

  it("still removes an ordinary contact's identity", async () => {
    const { contact, identity } = await contactWithEmail({});
    const result = await handler.execute(ctxFor({ contact_id: contact.id, identity_id: identity.id }));
    expect(result).toEqual({ success: true, data: { removed: true } });
    expect(await contacts.getIdentity(identity.id)).toBeNull();
  });

  it('refuses an identity that belongs to another contact', async () => {
    const { identity } = await contactWithEmail({ systemRole: 'principal' });
    const other = await contacts.createContact({ displayName: 'Dana Whitfield', source: 'ceo_stated' });
    const result = await handler.execute(ctxFor({ contact_id: other.id, identity_id: identity.id }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/does not belong to contact/);
    expect(await contacts.getIdentity(identity.id)).not.toBeNull();
  });
});
