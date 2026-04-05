import { describe, it, expect } from 'vitest';
import { ContactFindDuplicatesHandler } from '../../../skills/contact-find-duplicates/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(
  input: Record<string, unknown>,
  contactServiceOverride?: Partial<{ findDuplicates: (minConfidence?: string) => Promise<unknown[]> }>,
): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    contactService: contactServiceOverride as never,
  };
}

describe('ContactFindDuplicatesHandler', () => {
  const handler = new ContactFindDuplicatesHandler();

  it('returns failure when contactService is not available', async () => {
    const result = await handler.execute(makeCtx({}));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('contactService');
  });

  it('returns empty list when no duplicates exist', async () => {
    const contactService = { findDuplicates: async () => [] };
    const result = await handler.execute(makeCtx({}, contactService));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { pairs: unknown[]; count: number };
      expect(data.pairs).toHaveLength(0);
      expect(data.count).toBe(0);
    }
  });

  it('passes min_confidence to findDuplicates', async () => {
    let calledWith: string | undefined;
    const contactService = {
      findDuplicates: async (minConfidence?: string) => {
        calledWith = minConfidence;
        return [];
      },
    };
    await handler.execute(makeCtx({ min_confidence: 'certain' }, contactService));
    expect(calledWith).toBe('certain');
  });

  it('rejects invalid min_confidence value', async () => {
    const contactService = { findDuplicates: async () => [] };
    const result = await handler.execute(makeCtx({ min_confidence: 'unknown_value' }, contactService));
    expect(result.success).toBe(false);
  });

  it('returns formatted duplicate pairs', async () => {
    const fakePair = {
      contactA: { id: 'aaa', displayName: 'Alice', role: 'CFO', identities: [] },
      contactB: { id: 'bbb', displayName: 'Alice Smith', role: null, identities: [] },
      score: 0.95,
      confidence: 'certain',
      reason: 'Similar name (0.95)',
    };
    const contactService = { findDuplicates: async () => [fakePair] };
    const result = await handler.execute(makeCtx({}, contactService));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { pairs: Array<{ contact_a: { contact_id: string } }>; count: number };
      expect(data.count).toBe(1);
      expect(data.pairs[0].contact_a.contact_id).toBe('aaa');
    }
  });
});
