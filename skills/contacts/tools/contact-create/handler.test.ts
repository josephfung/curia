import { describe, it, expect, beforeEach } from 'vitest';
import pino from 'pino';
import { ContactCreateHandler } from './handler.js';
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

describe('ContactCreateHandler duplicate check (#2041)', () => {
  let contacts: ContactService;
  const handler = new ContactCreateHandler();

  beforeEach(async () => {
    contacts = ContactService.createInMemory();
    const existing = await contacts.createContact({ displayName: 'Priya Natarajan', source: 'ceo_stated' });
    await contacts.linkIdentity({
      contactId: existing.id,
      channel: 'email',
      channelIdentifier: 'priya@example.test',
      source: 'ceo_stated',
    });
  });

  it('refuses an exact address even with confirm_new, and does not create', async () => {
    const before = await contacts.listContacts();
    const result = await handler.execute(makeCtx(contacts, {
      name: 'Priya Again',
      email: 'PRIYA@example.test',
      confirm_new: true,
    }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/already on a contact/);
      expect(result.error).not.toMatch(/@/);
    }
    expect(await contacts.listContacts()).toHaveLength(before.length);
  });

  it('refuses a near-miss address unless confirm_new is true', async () => {
    const refused = await handler.execute(makeCtx(contacts, {
      name: 'Priya N',
      email: 'priya@example.tes',
    }));
    expect(refused.success).toBe(false);
    if (!refused.success) expect(refused.error).toMatch(/confirm_new true/);

    const created = await handler.execute(makeCtx(contacts, {
      name: 'Priya N',
      email: 'priya@example.tes',
      confirm_new: 'true',
    }));
    expect(created.success).toBe(true);
    if (created.success) expect(created.data).toMatchObject({ source: 'agent_created' });
  });

  it('refuses a similar name', async () => {
    const result = await handler.execute(makeCtx(contacts, { name: 'Priya Natrajan' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/Similar name/);
  });

  it('creates a unique person as agent_created and verifies the identity', async () => {
    const result = await handler.execute(makeCtx(contacts, {
      name: 'Dana Cho',
      email: 'dana.cho@example.test',
    }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as { contact_id: string; source: string };
    expect(data.source).toBe('agent_created');
    const found = await contacts.getContactWithIdentities(data.contact_id);
    expect(found?.identities[0]).toMatchObject({
      source: 'agent_created',
      verified: true,
      channelIdentifier: 'dana.cho@example.test',
    });
  });
});
