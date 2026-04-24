import { describe, it, expect, beforeEach } from 'vitest';
import pino from 'pino';
import { ContactRenameHandler } from './handler.js';
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

describe('ContactRenameHandler', () => {
  let contactService: ContactService;

  beforeEach(async () => {
    contactService = ContactService.createInMemory();
  });

  it('returns error when contact_id is missing', async () => {
    const handler = new ContactRenameHandler();
    const ctx = makeCtx({ input: { display_name: 'Jodi Arnott' }, contactService });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/contact_id/);
  });

  it('returns error when display_name is missing', async () => {
    const handler = new ContactRenameHandler();
    const ctx = makeCtx({ input: { contact_id: '00000000-0000-0000-0000-000000000001' }, contactService });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/display_name/);
  });

  it('returns error when contact_id is not a UUID', async () => {
    const handler = new ContactRenameHandler();
    const ctx = makeCtx({ input: { contact_id: 'not-a-uuid', display_name: 'Jodi Arnott' }, contactService });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/UUID/);
  });

  it('returns error when display_name exceeds 200 characters', async () => {
    const handler = new ContactRenameHandler();
    const ctx = makeCtx({
      input: { contact_id: '00000000-0000-0000-0000-000000000001', display_name: 'a'.repeat(201) },
      contactService,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/200 characters/);
  });

  it('returns error when contactService is not injected', async () => {
    const handler = new ContactRenameHandler();
    const ctx = makeCtx({
      input: { contact_id: '00000000-0000-0000-0000-000000000001', display_name: 'Jodi Arnott' },
      contactService: undefined,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/contactService/);
  });

  it('returns error for unknown contact ID', async () => {
    const handler = new ContactRenameHandler();
    const ctx = makeCtx({
      input: { contact_id: '00000000-0000-0000-0000-000000000099', display_name: 'Jodi Arnott' },
      contactService,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/No contact exists/);
  });

  it('renames a contact successfully', async () => {
    // Create a contact with just a first name (as Curia does when first creating from context)
    const contact = await contactService.createContact({
      displayName: 'Jodi',
      source: 'ceo_stated',
    });

    const handler = new ContactRenameHandler();
    const ctx = makeCtx({
      input: { contact_id: contact.id, display_name: 'Jodi Arnott' },
      contactService,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { contact_id: string; display_name: string; role: string | null } }).data;
    expect(data.contact_id).toBe(contact.id);
    expect(data.display_name).toBe('Jodi Arnott');
    expect(data.role).toBeNull();
  });

  it('preserves role when renaming', async () => {
    const contact = await contactService.createContact({
      displayName: 'Thusenth',
      role: 'Co-Founder & CEO at Sociavore',
      source: 'ceo_stated',
    });

    const handler = new ContactRenameHandler();
    const ctx = makeCtx({
      input: { contact_id: contact.id, display_name: 'Thusenth Dhavaloganathan' },
      contactService,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { contact_id: string; display_name: string; role: string | null } }).data;
    expect(data.display_name).toBe('Thusenth Dhavaloganathan');
    expect(data.role).toBe('Co-Founder & CEO at Sociavore');
  });
});
