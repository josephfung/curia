// contact-link-identity (#2041): agent-entered addresses carry agent_stated, pass the
// duplicate check first, and re-stating an address an agent typed earlier verifies it.

import { describe, it, expect, beforeEach } from 'vitest';
import pino from 'pino';
import { ContactLinkIdentityHandler } from './handler.js';
import { ContactService } from '../../../../src/contacts/contact-service.js';
import type { ToolContext } from '../../../../src/skills/types.js';

const silentLog = pino({ level: 'silent' });

function makeCtx(contactService: ContactService, input: Record<string, unknown>): ToolContext {
  return { input, secret: () => 'unused', log: silentLog, contactService } as unknown as ToolContext;
}

describe('ContactLinkIdentityHandler', () => {
  let contacts: ContactService;
  let handler: ContactLinkIdentityHandler;
  let danaId: string;
  let priyaId: string;

  beforeEach(async () => {
    contacts = ContactService.createInMemory();
    handler = new ContactLinkIdentityHandler();
    const dana = await contacts.createContact({ displayName: 'Dana Whitfield', source: 'ceo_stated' });
    danaId = dana.id;
    const priya = await contacts.createContact({ displayName: 'Priya Natarajan', source: 'ceo_stated' });
    priyaId = priya.id;
    await contacts.linkIdentity({ contactId: priya.id, channel: 'email', channelIdentifier: 'priya@example.test', source: 'ceo_stated' });
  });

  it('links a new address as agent_stated and verified', async () => {
    const result = await handler.execute(makeCtx(contacts, {
      contact_id: danaId, channel: 'email', identifier: 'Dana@NewCo.example', label: 'work',
    }));
    expect(result).toMatchObject({ success: true, data: { verified: true, already_linked: false } });
    const found = await contacts.getContactWithIdentities(danaId);
    expect(found!.identities[0]).toMatchObject({
      channelIdentifier: 'dana@newco.example', source: 'agent_stated', verified: true, label: 'work',
    });
  });

  it('refuses an address another contact holds, naming that contact', async () => {
    const result = await handler.execute(makeCtx(contacts, { contact_id: danaId, channel: 'email', identifier: 'priya@example.test' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain(priyaId);
      expect(result.error).toMatch(/Nothing was linked/);
      expect(result.error).not.toContain('priya@example.test');
    }
  });

  it('refuses a near-miss of another contact address until distinct_from names that contact', async () => {
    const input = { contact_id: danaId, channel: 'email', identifier: 'priya@exmaple.test' };
    const refused = await handler.execute(makeCtx(contacts, input));
    expect(refused.success).toBe(false);
    if (!refused.success) expect(refused.error).toContain(`"Priya Natarajan" (${priyaId}): similar email address`);
    const retried = await handler.execute(makeCtx(contacts, { ...input, distinct_from: [priyaId] }));
    expect(retried.success).toBe(true);
  });

  it('re-stating a verified address on this contact changes nothing', async () => {
    const result = await handler.execute(makeCtx(contacts, { contact_id: priyaId, channel: 'email', identifier: 'Priya@Example.test' }));
    expect(result).toMatchObject({ success: true, data: { verified: true, already_linked: true } });
    expect((await contacts.getContactWithIdentities(priyaId))!.identities).toHaveLength(1);
  });

  it('re-stating an unverified outbound_recipient address verifies it, keeping its source', async () => {
    const recipient = await contacts.createContact({ displayName: 'new.person@cold.example', source: 'outbound_recipient' });
    await contacts.linkIdentity({
      contactId: recipient.id, channel: 'email', channelIdentifier: 'new.person@cold.example', source: 'outbound_recipient',
    });
    const result = await handler.execute(makeCtx(contacts, {
      contact_id: recipient.id, channel: 'email', identifier: 'new.person@cold.example',
    }));
    expect(result).toMatchObject({ success: true, data: { verified: true, already_linked: true } });
    const identity = (await contacts.getContactWithIdentities(recipient.id))!.identities[0];
    expect(identity).toMatchObject({ source: 'outbound_recipient', verified: true });
  });

  it('finds a stored number when it is re-stated in another format (Review Focus 5)', async () => {
    const recipient = await contacts.createContact({ displayName: 'Text Only', source: 'outbound_recipient' });
    await contacts.linkIdentity({
      contactId: recipient.id, channel: 'sms', channelIdentifier: '+14165550100', source: 'outbound_recipient',
    });
    const result = await handler.execute(makeCtx(contacts, {
      contact_id: recipient.id, channel: 'sms', identifier: '+1 (416) 555-0100',
    }));
    expect(result).toMatchObject({ success: true, data: { verified: true, already_linked: true } });
    expect((await contacts.getContactWithIdentities(recipient.id))!.identities).toHaveLength(1);
  });

  it.each(['self_claimed', 'sms_participant'] as const)('will not vouch for an unverified %s address', async (source) => {
    await contacts.linkIdentity({ contactId: danaId, channel: 'sms', channelIdentifier: '+14165550199', source });
    const result = await handler.execute(makeCtx(contacts, { contact_id: danaId, channel: 'sms', identifier: '+14165550199' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/Only the principal can verify it/);
    expect((await contacts.getContactWithIdentities(danaId))!.identities[0]!.verified).toBe(false);
  });

  it('refuses an unknown contact ID and a malformed identifier', async () => {
    const missing = await handler.execute(makeCtx(contacts, {
      contact_id: '00000000-0000-4000-8000-000000000000', channel: 'email', identifier: 'x@y.example',
    }));
    expect(missing.success).toBe(false);
    if (!missing.success) expect(missing.error).toMatch(/No contact has ID/);
    const malformed = await handler.execute(makeCtx(contacts, { contact_id: danaId, channel: 'sms', identifier: 'call me' }));
    expect(malformed.success).toBe(false);
  });

  // Structural contacts (systemRole non-null): the principal's verified identities are
  // trusted as the principal by Gate C and the "principal" alias, so an agent must not
  // be able to add to, re-state, or verify any of them.
  describe('structural contacts', () => {
    it('refuses a new address on the principal, without leaking the principal contact ID', async () => {
      const principal = await contacts.createContact({ displayName: 'Joseph Fung', source: 'ceo_stated' });
      await contacts.saveContact({ ...principal, systemRole: 'principal' });
      const result = await handler.execute(makeCtx(contacts, {
        contact_id: principal.id, channel: 'email', identifier: 'attacker@evil.example',
      }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("The principal's addresses are managed by the principal, in the console. Nothing was linked.");
        expect(result.error).not.toContain(principal.id);
      }
      expect((await contacts.getContactWithIdentities(principal.id))!.identities).toHaveLength(0);
    });

    it('refuses re-stating an existing verified address on the principal, changing nothing', async () => {
      const principal = await contacts.createContact({ displayName: 'Joseph Fung', source: 'ceo_stated' });
      await contacts.saveContact({ ...principal, systemRole: 'principal' });
      await contacts.linkIdentity({
        contactId: principal.id, channel: 'email', channelIdentifier: 'joseph@example.test', source: 'ceo_stated',
      });
      const before = (await contacts.getContactWithIdentities(principal.id))!.identities;
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ verified: true });

      const result = await handler.execute(makeCtx(contacts, {
        contact_id: principal.id, channel: 'email', identifier: 'Joseph@Example.test',
      }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/managed by the principal, in the console/);
        expect(result.error).not.toContain(principal.id);
      }
      const after = (await contacts.getContactWithIdentities(principal.id))!.identities;
      expect(after).toEqual(before);
    });

    it('refuses verifying an unverified outbound_recipient address on the principal', async () => {
      const principal = await contacts.createContact({ displayName: 'Joseph Fung', source: 'ceo_stated' });
      await contacts.saveContact({ ...principal, systemRole: 'principal' });
      await contacts.linkIdentity({
        contactId: principal.id, channel: 'email', channelIdentifier: 'joseph.alt@example.test', source: 'outbound_recipient',
      });
      const result = await handler.execute(makeCtx(contacts, {
        contact_id: principal.id, channel: 'email', identifier: 'joseph.alt@example.test',
      }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/managed by the principal, in the console/);
        expect(result.error).not.toContain(principal.id);
      }
      expect((await contacts.getContactWithIdentities(principal.id))!.identities[0]!.verified).toBe(false);
    });

    it.each(['agent', 'system'] as const)('refuses a new address on a %s system-role contact', async (systemRole) => {
      const structural = await contacts.createContact({ displayName: 'Curia Internal', source: 'ceo_stated' });
      await contacts.saveContact({ ...structural, systemRole });
      const result = await handler.execute(makeCtx(contacts, {
        contact_id: structural.id, channel: 'email', identifier: 'curia@example.test',
      }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('This is a system contact; its addresses are not managed by agents. Nothing was linked.');
      }
      expect((await contacts.getContactWithIdentities(structural.id))!.identities).toHaveLength(0);
    });

    // isStructuralContact, not systemRole alone: a principal or agent row whose system
    // role was never set is still off limits.
    it.each([
      ['kind principal', { kind: 'principal' }],
      ['kind agent', { kind: 'agent' }],
      ['tier principal', { tier: 'principal' }],
    ] as const)('refuses a contact with no system role but %s', async (_label, fields) => {
      const structural = await contacts.createContact({ displayName: 'Curia Internal', source: 'ceo_stated' });
      await contacts.saveContact({ ...structural, ...fields });
      const result = await handler.execute(makeCtx(contacts, {
        contact_id: structural.id, channel: 'email', identifier: 'curia@example.test',
      }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('This is a system contact; its addresses are not managed by agents. Nothing was linked.');
      }
      expect((await contacts.getContactWithIdentities(structural.id))!.identities).toHaveLength(0);
    });
  });
});
