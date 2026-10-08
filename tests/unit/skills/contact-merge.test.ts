import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContactMergeHandler } from '../../../skills/contacts/tools/contact-merge/handler.js';
import { ContactService } from '../../../src/contacts/contact-service.js';
import type { Contact } from '../../../src/contacts/types.js';
import type { ToolContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });
const VALID_UUID_A = '550e8400-e29b-41d4-a716-446655440000';
const VALID_UUID_B = '550e8400-e29b-41d4-a716-446655440001';

// What the structural guard reads of each contact: an ordinary person.
const ORDINARY = { id: VALID_UUID_A, systemRole: null, kind: 'person', tier: 'known' } as unknown as Contact;

function makeCtx(
  input: Record<string, unknown>,
  overrides?: Partial<ToolContext>,
): ToolContext {
  return {
    toolName: 'contact-merge',
    toolVersion: '1.1.0',
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    caller: { contactId: 'ceo', role: 'ceo', channel: 'cli' },
    ...overrides,
  };
}

describe('ContactMergeHandler', () => {
  const handler = new ContactMergeHandler();

  it('returns failure when primary_contact_id is missing', async () => {
    const result = await handler.execute(makeCtx({ secondary_contact_id: VALID_UUID_B }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('primary_contact_id');
  });

  it('returns failure when secondary_contact_id is missing', async () => {
    const result = await handler.execute(makeCtx({ primary_contact_id: VALID_UUID_A }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('secondary_contact_id');
  });

  it('returns failure when IDs are not valid UUIDs', async () => {
    const result = await handler.execute(makeCtx({
      primary_contact_id: 'contact_jenna',
      secondary_contact_id: VALID_UUID_B,
    }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('UUID');
  });

  it('returns failure when both IDs are the same', async () => {
    const result = await handler.execute(makeCtx({
      primary_contact_id: VALID_UUID_A,
      secondary_contact_id: VALID_UUID_A,
    }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('same');
  });

  it('returns failure when contactService is not available', async () => {
    const result = await handler.execute(makeCtx({
      primary_contact_id: VALID_UUID_A,
      secondary_contact_id: VALID_UUID_B,
    }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('contactService');
  });

  it('proceeds without caller context (elevated gate enforced by execution layer)', async () => {
    // The handler no longer guards on ctx.caller — principal origination is
    // enforced by the execution layer's elevated-skill gate. Delegated specialists
    // don't receive senderContext, so caller is undefined in that path.
    const goldenRecord = {
      displayName: 'Jenna Torres', role: 'CFO', notes: null,
      tier: 'known', identities: [], authOverrides: [],
    };
    const contactService = {
      getContact: vi.fn().mockResolvedValue(ORDINARY),
      mergeContacts: vi.fn().mockResolvedValue({
        primaryContactId: VALID_UUID_A,
        secondaryContactId: VALID_UUID_B,
        goldenRecord,
        dryRun: true,
      }),
    };
    const result = await handler.execute(makeCtx(
      { primary_contact_id: VALID_UUID_A, secondary_contact_id: VALID_UUID_B },
      { contactService: contactService as never, caller: undefined },
    ));
    expect(result.success).toBe(true);
    expect(contactService.mergeContacts).toHaveBeenCalledWith(VALID_UUID_A, VALID_UUID_B, true);
  });

  it('calls mergeContacts with dry_run: true by default', async () => {
    const goldenRecord = {
      displayName: 'Jenna Torres', role: 'CFO', notes: null,
      tier: 'known', identities: [], authOverrides: [],
    };
    const contactService = {
      getContact: vi.fn().mockResolvedValue(ORDINARY),
      mergeContacts: vi.fn().mockResolvedValue({
        primaryContactId: VALID_UUID_A,
        secondaryContactId: VALID_UUID_B,
        goldenRecord,
        dryRun: true,
      }),
    };
    const result = await handler.execute(makeCtx(
      { primary_contact_id: VALID_UUID_A, secondary_contact_id: VALID_UUID_B },
      { contactService: contactService as never },
    ));
    expect(result.success).toBe(true);
    expect(contactService.mergeContacts).toHaveBeenCalledWith(VALID_UUID_A, VALID_UUID_B, true);
    if (result.success) {
      const data = result.data as { dry_run: boolean };
      expect(data.dry_run).toBe(true);
    }
  });

  it('calls mergeContacts with dry_run: false when specified', async () => {
    const contactService = {
      getContact: vi.fn().mockResolvedValue(ORDINARY),
      mergeContacts: vi.fn().mockResolvedValue({
        primaryContactId: VALID_UUID_A,
        secondaryContactId: VALID_UUID_B,
        goldenRecord: { displayName: 'Alice', role: null, notes: null, tier: 'known', identities: [], authOverrides: [] },
        dryRun: false,
        mergedAt: new Date('2026-04-05T12:00:00Z'),
      }),
    };
    const result = await handler.execute(makeCtx(
      { primary_contact_id: VALID_UUID_A, secondary_contact_id: VALID_UUID_B, dry_run: false },
      { contactService: contactService as never },
    ));
    expect(result.success).toBe(true);
    expect(contactService.mergeContacts).toHaveBeenCalledWith(VALID_UUID_A, VALID_UUID_B, false);
    if (result.success) {
      const data = result.data as { merged_at: string };
      expect(data.merged_at).toBe('2026-04-05T12:00:00.000Z');
    }
  });

  it('surfaces "not found" error with contact-lookup guidance', async () => {
    const { ContactNotFoundError } = await import('../../../src/contacts/types.js');
    const contactService = {
      // A missing contact passes the structural guard; mergeContacts reports it.
      getContact: vi.fn().mockResolvedValue(undefined),
      mergeContacts: vi.fn().mockRejectedValue(new ContactNotFoundError(VALID_UUID_A)),
    };
    const result = await handler.execute(makeCtx(
      { primary_contact_id: VALID_UUID_A, secondary_contact_id: VALID_UUID_B },
      { contactService: contactService as never },
    ));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('contact-lookup');
    }
  });

  it('refuses, and merges nothing, when the contact lookup fails', async () => {
    const contactService = {
      getContact: vi.fn().mockRejectedValue(new Error('db down')),
      mergeContacts: vi.fn(),
    };
    const result = await handler.execute(makeCtx(
      { primary_contact_id: VALID_UUID_A, secondary_contact_id: VALID_UUID_B, dry_run: false },
      { contactService: contactService as never },
    ));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/lookup failed\. Nothing was merged/);
    expect(contactService.mergeContacts).not.toHaveBeenCalled();
  });
});

// Agents cannot change a structural contact's identities (#2041). A merge moves the
// secondary's identities onto the primary, so contact-create then contact-merge into
// the principal would add a verified address the principal's alias and Gate C trust.
describe('ContactMergeHandler — structural contacts', () => {
  const handler = new ContactMergeHandler();
  let contacts: ContactService;
  let eve: Contact;

  function ctxFor(input: Record<string, unknown>): ToolContext {
    return makeCtx(input, { contactService: contacts });
  }

  async function structural(fields: Partial<Contact>): Promise<Contact> {
    const contact = await contacts.createContact({ displayName: 'Pat Principal', source: 'ceo_stated' });
    await contacts.saveContact({ ...contact, ...fields });
    await contacts.linkIdentity({ contactId: contact.id, channel: 'email', channelIdentifier: 'pat@home.example', source: 'ceo_stated' });
    return contact;
  }

  beforeEach(async () => {
    contacts = ContactService.createInMemory();
    eve = await contacts.createContact({ displayName: 'Eve Mallory', source: 'agent_stated' });
    await contacts.linkIdentity({ contactId: eve.id, channel: 'email', channelIdentifier: 'eve@evil.example', source: 'agent_stated' });
  });

  async function unchanged(primary: Contact): Promise<void> {
    expect(await contacts.getContact(eve.id)).toBeDefined();
    expect((await contacts.resolveByChannelIdentity('email', 'eve@evil.example'))?.contactId).toBe(eve.id);
    const identities = (await contacts.getContactWithIdentities(primary.id))!.identities;
    expect(identities.map((i) => i.channelIdentifier)).toEqual(['pat@home.example']);
  }

  it('refuses a merge into the principal, naming no contact, and changes nothing', async () => {
    const principal = await structural({ systemRole: 'principal' });
    for (const dry_run of [true, false]) {
      const result = await handler.execute(ctxFor({
        primary_contact_id: principal.id, secondary_contact_id: eve.id, dry_run,
      }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("The principal's addresses are managed by the principal, in the console. Nothing was merged.");
        expect(result.error).not.toContain(principal.id);
        expect(result.error).not.toContain(eve.id);
      }
    }
    await unchanged(principal);
  });

  it.each([
    ['an agent system role', { systemRole: 'agent' }],
    ['kind principal and no system role', { kind: 'principal' }],
  ] as const)('refuses a merge into a contact with %s', async (_label, fields) => {
    const primary = await structural(fields);
    const result = await handler.execute(ctxFor({
      primary_contact_id: primary.id, secondary_contact_id: eve.id, dry_run: false,
    }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('This is a system contact; its addresses are not managed by agents. Nothing was merged.');
    }
    await unchanged(primary);
  });

  it('refuses the principal as the secondary with the same message', async () => {
    const principal = await structural({ systemRole: 'principal' });
    const result = await handler.execute(ctxFor({
      primary_contact_id: eve.id, secondary_contact_id: principal.id, dry_run: false,
    }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("The principal's addresses are managed by the principal, in the console. Nothing was merged.");
    }
    await unchanged(principal);
  });

  it('still merges two ordinary contacts', async () => {
    const dana = await contacts.createContact({ displayName: 'Dana Whitfield', source: 'ceo_stated' });
    const result = await handler.execute(ctxFor({
      primary_contact_id: dana.id, secondary_contact_id: eve.id, dry_run: false,
    }));
    expect(result).toMatchObject({ success: true, data: { primary_contact_id: dana.id, dry_run: false } });
    expect(await contacts.getContact(eve.id)).toBeUndefined();
    expect((await contacts.resolveByChannelIdentity('email', 'eve@evil.example'))?.contactId).toBe(dana.id);
  });
});
