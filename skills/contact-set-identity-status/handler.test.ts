import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContactSetIdentityStatusHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { ContactService } from '../../src/contacts/contact-service.js';
import type { ChannelIdentity } from '../../src/contacts/types.js';
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

function makeCtx(overrides: {
  input?: Record<string, unknown>;
  contactService?: Partial<ContactService>;
}): SkillContext {
  const contactService = {
    setIdentityStatus: vi.fn().mockResolvedValue(makeIdentity({ status: 'defunct' })),
    ...overrides.contactService,
  } as unknown as ContactService;

  return {
    input: overrides.input ?? {},
    secret: () => '',
    log: makeLogger(),
    contactService,
  } as unknown as SkillContext;
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
    (ctx as Record<string, unknown>).contactService = undefined;
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/contactService/);
  });

  it('returns error when identity is not found', async () => {
    const contactService = {
      setIdentityStatus: vi.fn().mockRejectedValue(new Error('Identity not found: ' + VALID_UUID)),
    };
    const ctx = makeCtx({ input: { identity_id: VALID_UUID, status: 'defunct' }, contactService });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/No identity exists/);
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
