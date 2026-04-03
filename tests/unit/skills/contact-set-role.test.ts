import { describe, it, expect, vi } from 'vitest';
import { ContactSetRoleHandler } from '../../../skills/contact-set-role/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(input: Record<string, unknown>, overrides?: Partial<SkillContext>): SkillContext {
  return { input, secret: () => { throw new Error('no secrets'); }, log: logger, ...overrides };
}

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('ContactSetRoleHandler', () => {
  const handler = new ContactSetRoleHandler();

  it('returns failure when contact_id is missing', async () => {
    const result = await handler.execute(makeCtx({ role: 'CFO' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('contact_id');
  });

  it('returns failure when role is missing', async () => {
    const result = await handler.execute(makeCtx({ contact_id: VALID_UUID }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('role');
  });

  it('returns failure when contact_id is a slug, not a UUID', async () => {
    // Regression test: agent hallucinated "contact_joseph_fung" style IDs instead of
    // looking up the real UUID first. This produced an opaque 22P02 DB error.
    const result = await handler.execute(makeCtx({ contact_id: 'contact_joseph_fung', role: 'Founder & CEO' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('UUID');
      expect(result.error).toContain('contact-lookup');
    }
  });

  it('returns failure when contact_id is a plain name, not a UUID', async () => {
    const result = await handler.execute(makeCtx({ contact_id: 'joseph fung', role: 'Founder & CEO' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('UUID');
  });

  it('returns failure when role exceeds 200 characters', async () => {
    const result = await handler.execute(makeCtx({ contact_id: VALID_UUID, role: 'x'.repeat(201) }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('200');
  });

  it('returns failure when contactService is not available', async () => {
    const result = await handler.execute(makeCtx({ contact_id: VALID_UUID, role: 'CFO' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('contactService');
  });

  it('sets the role and returns updated contact details', async () => {
    const contactService = {
      setRole: vi.fn().mockResolvedValue({ id: VALID_UUID, displayName: 'Joseph Fung', role: 'Founder & CEO' }),
    };
    const result = await handler.execute(
      makeCtx({ contact_id: VALID_UUID, role: 'Founder & CEO' }, { contactService: contactService as never }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { contact_id: string; display_name: string; role: string };
      expect(data.contact_id).toBe(VALID_UUID);
      expect(data.display_name).toBe('Joseph Fung');
      expect(data.role).toBe('Founder & CEO');
    }
    expect(contactService.setRole).toHaveBeenCalledWith(VALID_UUID, 'Founder & CEO');
  });
});
