// contact-create (#2041): agent-entered contacts carry agent_stated, and nothing is
// written until the duplicate check passes.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import pino from 'pino';
import { ContactCreateHandler } from './handler.js';
import { ContactService } from '../../../../src/contacts/contact-service.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import { sourceKeyFor, sourceKeysInText, type IdentifierSources } from '../../../../src/contacts/identifier-provenance.js';

const silentLog = pino({ level: 'silent' });

// Most cases here are about the duplicate check, so every identifier has a source unless
// a case says otherwise. Provenance cases pass their own (#2061).
const EVERYTHING_SOURCED: IdentifierSources = { has: async () => true };

function makeCtx(
  contactService: ContactService,
  input: Record<string, unknown>,
  extra: Partial<ToolContext> = { identifierSources: EVERYTHING_SOURCED },
): ToolContext {
  return { input, secret: () => 'unused', log: silentLog, contactService, ...extra } as unknown as ToolContext;
}

/** Sources that hold exactly these identifiers, as the runtime's lookup would. */
function sourcesFrom(text: string): IdentifierSources {
  const keys = sourceKeysInText(text);
  return { has: async (channel, identifier) => keys.has(sourceKeyFor(channel, identifier)) };
}

describe('ContactCreateHandler', () => {
  let contacts: ContactService;
  let handler: ContactCreateHandler;
  let priyaId: string;
  let principalId: string;

  beforeEach(async () => {
    contacts = ContactService.createInMemory();
    handler = new ContactCreateHandler();
    const priya = await contacts.createContact({ displayName: 'Priya Natarajan', source: 'ceo_stated' });
    priyaId = priya.id;
    await contacts.linkIdentity({ contactId: priya.id, channel: 'email', channelIdentifier: 'priya.natarajan@example.test', source: 'ceo_stated' });
    const principal = await contacts.createContact({ displayName: 'Pat Principal', source: 'ceo_stated' });
    await contacts.saveContact({ ...principal, systemRole: 'principal' });
    principalId = principal.id;
    await contacts.linkIdentity({ contactId: principal.id, channel: 'email', channelIdentifier: 'pat@principal.example', source: 'ceo_stated' });
  });

  async function count(): Promise<number> {
    return (await contacts.listContacts()).length;
  }

  it('creates a contact whose identities are agent_stated, verified and normalized', async () => {
    const result = await handler.execute(makeCtx(contacts, {
      name: 'Dana Whitfield', email: 'Dana.Whitfield@NewCo.example', sms: '(416) 555-0100',
    }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as { contact_id: string; identities_added: number };
    expect(data.identities_added).toBe(2);
    const found = await contacts.getContactWithIdentities(data.contact_id);
    expect(found!.identities.map((i) => [i.channel, i.channelIdentifier, i.source, i.verified])).toEqual([
      ['email', 'dana.whitfield@newco.example', 'agent_stated', true],
      ['sms', '+14165550100', 'agent_stated', true],
    ]);
  });

  it('creates a name-only contact', async () => {
    const result = await handler.execute(makeCtx(contacts, { name: 'Morgan Lee' }));
    expect(result.success).toBe(true);
  });

  it('refuses a missing or blank name and writes nothing', async () => {
    const before = await count();
    const missing = await handler.execute(makeCtx(contacts, { email: 'dana@newco.example' }));
    expect(missing.success).toBe(false);
    if (!missing.success) expect(missing.error).toMatch(/Missing required input: name/);
    // A whitespace-only name would sanitize to "Unknown" and match every contact named that.
    const blank = await handler.execute(makeCtx(contacts, { name: '   ' }));
    expect(blank.success).toBe(false);
    if (!blank.success) expect(blank.error).toMatch(/Missing required input: name/);
    expect(await count()).toBe(before);
  });

  it('skips a blank or whitespace-only optional channel input (Review Focus 1)', async () => {
    const result = await handler.execute(makeCtx(contacts, {
      name: 'Dana Whitfield', email: 'dana@newco.example', phone: ' ', sms: '', signal: null, slack: '   ',
    }));
    expect(result).toMatchObject({ success: true, data: { identities_added: 1 } });
    if (!result.success) return;
    const found = await contacts.getContactWithIdentities((result.data as { contact_id: string }).contact_id);
    expect(found!.identities.map((i) => i.channel)).toEqual(['email']);
  });

  it('refuses a malformed identifier and writes nothing', async () => {
    const before = await count();
    const result = await handler.execute(makeCtx(contacts, { name: 'Dana Whitfield', email: 'dana at newco' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/email must be an email address.*No contact was created/s);
    expect(await count()).toBe(before);
  });

  it('refuses an address another contact holds, naming that contact, with no override', async () => {
    const before = await count();
    const result = await handler.execute(makeCtx(contacts, {
      name: 'P. Natarajan', email: 'PRIYA.NATARAJAN@example.test', distinct_from: [priyaId],
    }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain(priyaId);
      expect(result.error).toContain('Priya Natarajan');
      expect(result.error).not.toContain('priya.natarajan@example.test');
    }
    expect(await count()).toBe(before);
  });

  it("refuses the principal's own address with the alias, never their contact ID", async () => {
    const result = await handler.execute(makeCtx(contacts, { name: 'Pat', email: 'pat@principal.example' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/principal's/);
      expect(result.error).toContain('"principal"');
      expect(result.error).not.toContain(principalId);
    }
  });

  it('refuses a near-miss of an existing address until distinct_from names that contact', async () => {
    const input = { name: 'Priya N', email: 'priya.natarajan@exmaple.test' };
    const refused = await handler.execute(makeCtx(contacts, input));
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error).toContain(`"Priya Natarajan" (${priyaId}): similar email address`);
      expect(refused.error).toContain('distinct_from');
      expect(refused.error).not.toContain('priya.natarajan@example.test');
    }
    const retried = await handler.execute(makeCtx(contacts, { ...input, distinct_from: [priyaId] }));
    expect(retried.success).toBe(true);
  });

  it('refuses a mistyped name of an existing contact until distinct_from names that contact', async () => {
    const before = await count();
    const refused = await handler.execute(makeCtx(contacts, { name: 'Priya Natrajan' }));
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error).toContain(`"Priya Natarajan" (${priyaId}): similar name`);
      expect(refused.error).toContain('distinct_from');
    }
    expect(await count()).toBe(before);
    const retried = await handler.execute(makeCtx(contacts, { name: 'Priya Natrajan', distinct_from: [priyaId] }));
    expect(retried.success).toBe(true);
    expect(await count()).toBe(before + 1);
  });

  it('accepts distinct_from as one comma-separated string', async () => {
    const result = await handler.execute(makeCtx(contacts, {
      name: 'Priya Natarajan', email: 'pn@other.example', distinct_from: ` ${priyaId} `,
    }));
    expect(result.success).toBe(true);
  });

  it('still refuses when distinct_from covers only some candidates', async () => {
    const second = await contacts.createContact({ displayName: 'Priya Natarajan', source: 'ceo_stated' });
    const result = await handler.execute(makeCtx(contacts, {
      name: 'Priya Natarajan', distinct_from: [priyaId],
    }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain(priyaId);
      expect(result.error).toContain(second.id);
    }
  });

  it('lists the principal as a candidate by alias, and "principal" in distinct_from clears it', async () => {
    const refused = await handler.execute(makeCtx(contacts, { name: 'Pat Vendor', email: 'pat@principal.exmaple' }));
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error).toContain('the principal');
      expect(refused.error).not.toContain(principalId);
    }
    const retried = await handler.execute(makeCtx(contacts, {
      name: 'Pat Vendor', email: 'pat@principal.exmaple', distinct_from: ['principal'],
    }));
    expect(retried.success).toBe(true);
  });

  it('lists a contact named after its address by ID only (Review Focus 3)', async () => {
    const gatewayMade = await contacts.createContact({ displayName: 'sam.rivera@vendor.example', source: 'outbound_recipient' });
    await contacts.linkIdentity({
      contactId: gatewayMade.id, channel: 'email', channelIdentifier: 'sam.rivera@vendor.example', source: 'outbound_recipient',
    });
    const result = await handler.execute(makeCtx(contacts, { name: 'Sam Rivera', email: 'sam.rivera@vendor.exmaple' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain(`contact ${gatewayMade.id}`);
      expect(result.error).not.toContain('sam.rivera@vendor.example');
    }
  });

  it('refuses, and writes nothing, when the duplicate check fails', async () => {
    vi.spyOn(contacts, 'findLikelyDuplicates').mockRejectedValueOnce(new Error('db down'));
    const before = await count();
    const result = await handler.execute(makeCtx(contacts, { name: 'Dana Whitfield', email: 'dana@newco.example' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/duplicate check could not run/);
    expect(await count()).toBe(before);
  });

  it('removes the contact it created when a concurrent create wins the address', async () => {
    const before = await count();
    vi.spyOn(contacts, 'linkIdentity').mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));
    const result = await handler.execute(makeCtx(contacts, { name: 'Dana Whitfield', email: 'dana@newco.example' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/just added to another contact/);
    expect(await count()).toBe(before);
  });
});

describe('ContactCreateHandler — identifier provenance (#2061)', () => {
  let contacts: ContactService;
  const handler = new ContactCreateHandler();

  beforeEach(async () => {
    contacts = ContactService.createInMemory();
    const priya = await contacts.createContact({ displayName: 'Priya Natarajan', source: 'ceo_stated' });
    await contacts.linkIdentity({ contactId: priya.id, channel: 'email', channelIdentifier: 'priya.natarajan@example.test', source: 'ceo_stated' });
  });

  it('verifies an address the principal stated, and a number stated in another format', async () => {
    const sources = sourcesFrom('Email Dana at dana.whitfield@newco.example, or text 416-555-0100');
    const result = await handler.execute(makeCtx(contacts, {
      name: 'Dana Whitfield', email: 'dana.whitfield@newco.example', sms: '+1 416 555 0100',
    }, { identifierSources: sources }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const found = await contacts.getContactWithIdentities((result.data as { contact_id: string }).contact_id);
    expect(found!.identities.every((identity) => identity.verified)).toBe(true);
  });

  it('refuses a typo of a stated address, writes nothing, and does not echo the address', async () => {
    const before = (await contacts.listContacts()).length;
    const result = await handler.execute(makeCtx(contacts, {
      name: 'Dana Whitfield', email: 'dana.whitfeld@newco.example',
    }, { identifierSources: sourcesFrom('Email Dana at dana.whitfield@newco.example') }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('appears in no message a person sent');
    expect(result.error).toContain('No contact was created.');
    expect(result.error).not.toContain('dana.whitfeld@newco.example');
    expect((await contacts.listContacts()).length).toBe(before);
  });

  it('refuses when the task has no sources at all', async () => {
    const result = await handler.execute(makeCtx(contacts, { name: 'Dana Whitfield', email: 'dana@newco.example' }, {}));
    expect(result.success).toBe(false);
  });

  it('still creates a name-only contact with no sources', async () => {
    const result = await handler.execute(makeCtx(contacts, { name: 'Morgan Lee' }, {}));
    expect(result.success).toBe(true);
  });

  it('reports an address already on file as taken, not as unsourced', async () => {
    const result = await handler.execute(makeCtx(contacts, { name: 'P. Natarajan', email: 'priya.natarajan@example.test' }, {}));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('already on');
  });

  it('treats a principal-approved replay as sourced', async () => {
    const result = await handler.execute(makeCtx(contacts, { name: 'Dana Whitfield', email: 'dana@newco.example' }, { humanApproved: true }));
    expect(result.success).toBe(true);
  });
});
