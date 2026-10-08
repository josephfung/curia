import { describe, it, expect, beforeEach } from 'vitest';
import pino from 'pino';
import { ContactLinkIdentityHandler } from './handler.js';
import { ContactService } from '../../../../src/contacts/contact-service.js';
import type { ToolContext } from '../../../../src/skills/types.js';

const silentLog = pino({ level: 'silent' });

function makeCtx(contactService: ContactService, input: Record<string, unknown>): ToolContext {
  return {
    input,
    secret: () => 'unused',
    log: silentLog,
    contactService,
  } as unknown as ToolContext;
}

describe('ContactLinkIdentityHandler duplicate check (#2041)', () => {
  let contacts: ContactService;
  let priyaId: string;
  let danaId: string;
  const handler = new ContactLinkIdentityHandler();

  beforeEach(async () => {
    contacts = ContactService.createInMemory();
    const priya = await contacts.createContact({ displayName: 'Priya Natarajan', source: 'ceo_stated' });
    priyaId = priya.id;
    await contacts.linkIdentity({
      contactId: priyaId,
      channel: 'email',
      channelIdentifier: 'priya@example.test',
      source: 'ceo_stated',
    });
    const dana = await contacts.createContact({ displayName: 'Dana Cho', source: 'ceo_stated' });
    danaId = dana.id;
  });

  it('refuses an address that is already on another contact', async () => {
    const result = await handler.execute(makeCtx(contacts, {
      contact_id: danaId,
      channel: 'email',
      identifier: 'priya@example.test',
      confirm_new: true,
    }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/already on a contact/);
      expect(result.error).not.toContain('priya@example.test');
    }
  });

  it('refuses an identifier already on this contact without echoing it', async () => {
    const result = await handler.execute(makeCtx(contacts, {
      contact_id: priyaId,
      channel: 'email',
      identifier: 'priya@example.test',
    }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/already on this contact/);
      expect(result.error).not.toContain('priya@example.test');
    }
  });

  it('requires confirm_new for a near-miss, then links agent_created verified', async () => {
    const refused = await handler.execute(makeCtx(contacts, {
      contact_id: danaId,
      channel: 'email',
      identifier: 'priya@example.tes',
    }));
    expect(refused.success).toBe(false);
    if (!refused.success) expect(refused.error).toMatch(/confirm_new true/);

    const linked = await handler.execute(makeCtx(contacts, {
      contact_id: danaId,
      channel: 'email',
      identifier: 'priya@example.tes',
      confirm_new: true,
    }));
    expect(linked.success).toBe(true);
    if (!linked.success) return;
    expect(linked.data).toMatchObject({ verified: true });
    const found = await contacts.getContactWithIdentities(danaId);
    const added = found?.identities.find((identity) => identity.channelIdentifier === 'priya@example.tes');
    expect(added).toMatchObject({ source: 'agent_created', verified: true });
  });

  it('does not treat the contact being updated as its own near-miss', async () => {
    const result = await handler.execute(makeCtx(contacts, {
      contact_id: priyaId,
      channel: 'email',
      identifier: 'priya@example.tes',
    }));
    expect(result.success).toBe(true);
  });
});
