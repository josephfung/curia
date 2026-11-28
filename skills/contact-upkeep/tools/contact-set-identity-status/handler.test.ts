import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContactSetIdentityStatusHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import { ContactService } from '../../../../src/contacts/contact-service.js';
import type { ChannelIdentity, Contact } from '../../../../src/contacts/types.js';
import { IdentityNotFoundError } from '../../../../src/contacts/types.js';
import pino from 'pino';

function makeLogger() {
  return pino({ level: 'silent' });
}

const VALID_UUID = '11111111-2222-3333-4444-555555555555';

function makeIdentity(overrides: Partial<ChannelIdentity> = {}): ChannelIdentity {
  return {
    id: VALID_UUID,
    contactId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    channel: 'email',
    channelIdentifier: 'jenna@acme.com',
    label: null,
    verified: true,
    verifiedAt: new Date(),
    status: 'active',
    source: 'ceo_stated',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// The identity's owner, as the structural guard reads it: an ordinary person.
const ORDINARY_OWNER = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', systemRole: null, kind: 'person', tier: 'known',
} as unknown as Contact;

function makeCtx(overrides: {
  input?: Record<string, unknown>;
  contactService?: Partial<ContactService>;
}): ToolContext {
  const contactService = {
    getIdentity: vi.fn().mockResolvedValue(makeIdentity()),
    getContact: vi.fn().mockResolvedValue(ORDINARY_OWNER),
    setIdentityStatus: vi.fn().mockResolvedValue(makeIdentity({ status: 'defunct' })),
    ...overrides.contactService,
  } as unknown as ContactService;

  return {
    input: overrides.input ?? {},
    secret: () => '',
    log: makeLogger(),
    contactService,
  } as unknown as ToolContext;
}

describe('ContactSetIdentityStatusHandler', () => {
  let handler: ContactSetIdentityStatusHandler;

  beforeEach(() => {
    handler = new ContactSetIdentityStatusHandler();
  });

  it('returns error when identity_id is missing', async () => {
    const ctx = makeCtx({ input: { status: 'defunct' } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/identity_id/);
  });

  it('returns error when identity_id is not a valid UUID', async () => {
    const ctx = makeCtx({ input: { identity_id: 'not-a-uuid', status: 'defunct' } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/UUID/);
  });

  it('returns error when status is missing', async () => {
    const ctx = makeCtx({ input: { identity_id: VALID_UUID } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/status/);
  });

  it('returns error when status is invalid', async () => {
    const ctx = makeCtx({ input: { identity_id: VALID_UUID, status: 'invalid' } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/active.*defunct.*bounced/);
  });

  it('returns error when contactService is not available', async () => {
    const ctx = makeCtx({ input: { identity_id: VALID_UUID, status: 'defunct' } });
    (ctx as unknown as Record<string, unknown>).contactService = undefined;
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/contactService/);
  });

  it('returns error when the identity lookup finds nothing, changing nothing', async () => {
    const setIdentityStatus = vi.fn();
    const contactService = { getIdentity: vi.fn().mockResolvedValue(null), setIdentityStatus };
    const ctx = makeCtx({ input: { identity_id: VALID_UUID, status: 'defunct' }, contactService });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/No identity exists/);
    expect(setIdentityStatus).not.toHaveBeenCalled();
  });

  it('returns error when identity is not found', async () => {
    const contactService = {
      setIdentityStatus: vi.fn().mockRejectedValue(new IdentityNotFoundError(VALID_UUID)),
    };
    const ctx = makeCtx({ input: { identity_id: VALID_UUID, status: 'defunct' }, contactService });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/No identity exists/);
  });

  it('returns generic error when an unexpected error occurs', async () => {
    const contactService = {
      setIdentityStatus: vi.fn().mockRejectedValue(new Error('connection refused')),
    };
    const ctx = makeCtx({ input: { identity_id: VALID_UUID, status: 'defunct' }, contactService });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/See logs/);
  });

  it('successfully updates identity status', async () => {
    const updatedIdentity = makeIdentity({ status: 'defunct' });
    const contactService = {
      setIdentityStatus: vi.fn().mockResolvedValue(updatedIdentity),
    };
    const ctx = makeCtx({
      input: { identity_id: VALID_UUID, status: 'defunct' },
      contactService,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.identity_id).toBe(VALID_UUID);
      expect(data.status).toBe('defunct');
      expect(data.channel).toBe('email');
      expect(data.identifier).toBe('jenna@acme.com');
      expect(data.contact_id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    }
    expect(contactService.setIdentityStatus).toHaveBeenCalledWith(VALID_UUID, 'defunct');
  });

  it('successfully updates to bounced', async () => {
    const updatedIdentity = makeIdentity({ status: 'bounced' });
    const contactService = {
      setIdentityStatus: vi.fn().mockResolvedValue(updatedIdentity),
    };
    const ctx = makeCtx({
      input: { identity_id: VALID_UUID, status: 'bounced' },
      contactService,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).status).toBe('bounced');
    }
  });

  it('successfully updates back to active', async () => {
    const updatedIdentity = makeIdentity({ status: 'active' });
    const contactService = {
      setIdentityStatus: vi.fn().mockResolvedValue(updatedIdentity),
    };
    const ctx = makeCtx({
      input: { identity_id: VALID_UUID, status: 'active' },
      contactService,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).status).toBe('active');
    }
  });
});

// Agents cannot change a structural contact's identities (#2041): re-activating a
// defunct principal address would make it sendable and trusted as the principal again.
describe('ContactSetIdentityStatusHandler — structural contacts', () => {
  const handler = new ContactSetIdentityStatusHandler();
  let contacts: ContactService;

  function ctxFor(input: Record<string, unknown>): ToolContext {
    return { input, secret: () => '', log: makeLogger(), contactService: contacts } as unknown as ToolContext;
  }

  async function contactWithEmail(systemRole: 'principal' | 'agent' | null) {
    const contact = await contacts.createContact({ displayName: 'Pat Principal', source: 'ceo_stated' });
    if (systemRole) await contacts.saveContact({ ...contact, systemRole });
    const identity = await contacts.linkIdentity({
      contactId: contact.id, channel: 'email', channelIdentifier: 'pat@old.example', source: 'ceo_stated', status: 'defunct',
    });
    return { contact, identity };
  }

  beforeEach(() => {
    contacts = ContactService.createInMemory();
  });

  it("refuses the principal's identity, changing nothing and naming no contact", async () => {
    const { contact, identity } = await contactWithEmail('principal');
    const result = await handler.execute(ctxFor({ identity_id: identity.id, status: 'active' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("The principal's addresses are managed by the principal, in the console. Nothing was changed.");
      expect(result.error).not.toContain(contact.id);
    }
    expect((await contacts.getIdentity(identity.id))!.status).toBe('defunct');
  });

  it("refuses an agent contact's identity", async () => {
    const { identity } = await contactWithEmail('agent');
    const result = await handler.execute(ctxFor({ identity_id: identity.id, status: 'active' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('This is a system contact; its addresses are not managed by agents. Nothing was changed.');
    }
    expect((await contacts.getIdentity(identity.id))!.status).toBe('defunct');
  });

  it("still changes an ordinary contact's identity", async () => {
    const { identity } = await contactWithEmail(null);
    const result = await handler.execute(ctxFor({ identity_id: identity.id, status: 'active' }));
    expect(result).toMatchObject({ success: true, data: { status: 'active' } });
    expect((await contacts.getIdentity(identity.id))!.status).toBe('active');
  });
});
