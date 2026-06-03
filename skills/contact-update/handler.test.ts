import { describe, it, expect, beforeEach } from 'vitest';
import pino from 'pino';
import { ContactUpdateHandler } from './handler.js';
import { ContactService } from '../../src/contacts/contact-service.js';
import type { SkillContext } from '../../src/skills/types.js';

const silentLog = pino({ level: 'silent' });

function makeCtx(overrides: Partial<SkillContext> = {}): SkillContext {
  return {
    input: {},
    secret: () => 'unused',
    log: silentLog,
    ...overrides,
  } as unknown as SkillContext;
}

describe('ContactUpdateHandler', () => {
  let handler: ContactUpdateHandler;
  let contactService: ContactService;

  beforeEach(async () => {
    handler = new ContactUpdateHandler();
    contactService = ContactService.createInMemory();
  });

  // ── Input validation ──────────────────────────────────────────────────────

  it('returns error when contact_id is missing', async () => {
    const ctx = makeCtx({ input: { fields: { title: 'VP of Engineering' } }, contactService });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/contact_id/);
  });

  it('returns error when contact_id is not a UUID', async () => {
    const ctx = makeCtx({
      input: { contact_id: 'not-a-uuid', fields: { title: 'VP of Engineering' } },
      contactService,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/UUID/);
  });

  it('returns error when fields is missing', async () => {
    const ctx = makeCtx({
      input: { contact_id: '00000000-0000-0000-0000-000000000001' },
      contactService,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/fields/);
  });

  it('returns error when fields is an empty object', async () => {
    const ctx = makeCtx({
      input: { contact_id: '00000000-0000-0000-0000-000000000001', fields: {} },
      contactService,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/at least one/);
  });

  it('returns error for an unknown field', async () => {
    const ctx = makeCtx({
      input: {
        contact_id: '00000000-0000-0000-0000-000000000001',
        fields: { unknownField: 'some value' },
      },
      contactService,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/Unknown field.*unknownField/);
  });

  it('returns error when contactService is not injected', async () => {
    const ctx = makeCtx({
      input: {
        contact_id: '00000000-0000-0000-0000-000000000001',
        fields: { title: 'VP of Engineering' },
      },
      contactService: undefined,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/contactService/);
  });

  it('returns error for unknown contact ID', async () => {
    const ctx = makeCtx({
      input: {
        contact_id: '00000000-0000-0000-0000-000000000099',
        fields: { title: 'VP of Engineering' },
      },
      contactService,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/No contact exists/);
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it('updates canonical fields successfully', async () => {
    const contact = await contactService.createContact({
      displayName: 'Jodi Arnott',
      source: 'ceo_stated',
    });

    const ctx = makeCtx({
      input: {
        contact_id: contact.id,
        fields: { title: 'VP of Engineering', organization: 'Acme Corp' },
      },
      contactService,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { contact_id: string; updated_fields: string[] } }).data;
    expect(data.contact_id).toBe(contact.id);
    expect(data.updated_fields).toContain('title');
    expect(data.updated_fields).toContain('organization');
    expect(data.updated_fields).toHaveLength(2);

    // Verify the contact record was actually updated
    const updated = await contactService.getContact(contact.id);
    expect(updated?.title).toBe('VP of Engineering');
    expect(updated?.organization).toBe('Acme Corp');
  });

  it('preserves unmentioned fields when updating a subset', async () => {
    const contact = await contactService.createContact({
      displayName: 'Thusenth',
      source: 'ceo_stated',
    });
    // Seed organization first
    await contactService.updateContactFields(contact.id, { organization: 'Sociavore' });

    const ctx = makeCtx({
      input: {
        contact_id: contact.id,
        fields: { title: 'Co-Founder & CEO' },
      },
      contactService,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);

    // organization must be preserved — partial PATCH must not clear it
    const updated = await contactService.getContact(contact.id);
    expect(updated?.title).toBe('Co-Founder & CEO');
    expect(updated?.organization).toBe('Sociavore');
  });

  // ── Phone normalization ───────────────────────────────────────────────────

  it('normalizes primaryPhone to E.164 format', async () => {
    const contact = await contactService.createContact({
      displayName: 'Aiyana Redcloud',
      source: 'ceo_stated',
    });

    const ctx = makeCtx({
      input: {
        contact_id: contact.id,
        fields: { primaryPhone: '416-555-1234' },
      },
      contactService,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const updated = await contactService.getContact(contact.id);
    expect(updated?.primaryPhone).toBe('+14165551234');
  });

  it('returns error when primaryPhone cannot be normalized to E.164', async () => {
    const contact = await contactService.createContact({
      displayName: 'Aiyana Redcloud',
      source: 'ceo_stated',
    });

    const ctx = makeCtx({
      input: {
        contact_id: contact.id,
        fields: { primaryPhone: 'not-a-phone-number' },
      },
      contactService,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/E\.164/);
  });

  it('clears primaryPhone when null is passed', async () => {
    const contact = await contactService.createContact({
      displayName: 'Aiyana Redcloud',
      source: 'ceo_stated',
    });
    await contactService.updateContactFields(contact.id, { primaryPhone: '+14165551234' });

    const ctx = makeCtx({
      input: {
        contact_id: contact.id,
        fields: { primaryPhone: null },
      },
      contactService,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const updated = await contactService.getContact(contact.id);
    expect(updated?.primaryPhone).toBeNull();
  });

  // ── ContactValidationError (primaryEmail not in CCI) ─────────────────────

  it('returns structured error when primaryEmail is not in contact_channel_identities', async () => {
    const contact = await contactService.createContact({
      displayName: 'Ada Lovelace',
      source: 'ceo_stated',
    });

    const ctx = makeCtx({
      input: {
        contact_id: contact.id,
        // This address has no CCI row — ContactService throws ContactValidationError
        fields: { primaryEmail: 'ada@example.com' },
      },
      contactService,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    const error = (result as { success: false; error: string }).error;
    expect(error).toMatch(/not found in contact_channel_identities/);
    expect(error).toMatch(/contact-link-identity/);
  });

  it('returns error when fields is an array instead of an object', async () => {
    const ctx = makeCtx({
      input: { contact_id: '00000000-0000-0000-0000-000000000001', fields: ['title'] },
      contactService,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/plain object/);
  });
});
