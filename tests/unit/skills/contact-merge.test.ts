import { describe, it, expect, vi } from 'vitest';
import { ContactMergeHandler } from '../../../skills/contact-merge/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });
const VALID_UUID_A = '550e8400-e29b-41d4-a716-446655440000';
const VALID_UUID_B = '550e8400-e29b-41d4-a716-446655440001';

function makeCtx(
  input: Record<string, unknown>,
  overrides?: Partial<SkillContext>,
): SkillContext {
  return {
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

  it('returns failure when caller context is missing', async () => {
    const contactService = {
      mergeContacts: vi.fn().mockResolvedValue({ dryRun: true }),
    };
    const result = await handler.execute(makeCtx(
      { primary_contact_id: VALID_UUID_A, secondary_contact_id: VALID_UUID_B },
      { contactService: contactService as never, caller: undefined },
    ));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('caller');
  });

  it('calls mergeContacts with dry_run: true by default', async () => {
    const goldenRecord = {
      displayName: 'Jenna Torres', role: 'CFO', notes: null,
      status: 'confirmed', identities: [], authOverrides: [],
    };
    const contactService = {
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
      mergeContacts: vi.fn().mockResolvedValue({
        primaryContactId: VALID_UUID_A,
        secondaryContactId: VALID_UUID_B,
        goldenRecord: { displayName: 'Alice', role: null, notes: null, status: 'confirmed', identities: [], authOverrides: [] },
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
    const contactService = {
      mergeContacts: vi.fn().mockRejectedValue(new Error(`Contact not found: ${VALID_UUID_A}`)),
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
});
