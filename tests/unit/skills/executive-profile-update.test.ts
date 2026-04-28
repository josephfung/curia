import { describe, it, expect, vi } from 'vitest';
import { ExecutiveProfileUpdateHandler } from '../../../skills/executive-profile-update/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import type { ExecutiveProfile } from '../../../src/executive/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

const baseProfile: ExecutiveProfile = {
  writingVoice: {
    tone: ['direct', 'warm'],
    formality: 50,
    patterns: ['Short sentences', 'Uses em dashes freely'],
    vocabulary: {
      prefer: ['straightforward', 'folks'],
      avoid: ['leverage', 'synergy'],
    },
    signOff: '-- Joseph',
  },
};

function makeCtx(
  input: Record<string, unknown>,
  service?: {
    get: () => ExecutiveProfile;
    update: (config: ExecutiveProfile, changedBy: string, note?: string) => Promise<void>;
  },
  caller?: { contactId?: string; role?: string },
): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    executiveProfileService: service as never,
    caller: caller as never,
  };
}

describe('ExecutiveProfileUpdateHandler', () => {
  const handler = new ExecutiveProfileUpdateHandler();

  it('returns failure when service is not available', async () => {
    const result = await handler.execute(makeCtx({ writing_voice: { formality: 30 } }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('executiveProfileService');
  });

  it('returns failure when writing_voice is missing', async () => {
    const service = { get: () => baseProfile, update: vi.fn() };
    const result = await handler.execute(makeCtx({}, service));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('writing_voice');
  });

  it('merges partial formality update onto current profile', async () => {
    let savedProfile: ExecutiveProfile | undefined;
    const service = {
      get: () => savedProfile ?? baseProfile,
      update: vi.fn(async (config: ExecutiveProfile) => { savedProfile = config; }),
    };

    const result = await handler.execute(makeCtx(
      { writing_voice: { formality: 25 } },
      service,
      { contactId: 'ceo-123' },
    ));

    expect(result.success).toBe(true);
    expect(service.update).toHaveBeenCalledOnce();

    // Check that only formality changed — tone, patterns, vocab, signOff preserved
    const updatedConfig = service.update.mock.calls[0][0] as ExecutiveProfile;
    expect(updatedConfig.writingVoice.formality).toBe(25);
    expect(updatedConfig.writingVoice.tone).toEqual(['direct', 'warm']);
    expect(updatedConfig.writingVoice.patterns).toEqual(['Short sentences', 'Uses em dashes freely']);
    expect(updatedConfig.writingVoice.vocabulary).toEqual({ prefer: ['straightforward', 'folks'], avoid: ['leverage', 'synergy'] });
    expect(updatedConfig.writingVoice.signOff).toBe('-- Joseph');
  });

  it('merges partial tone update', async () => {
    const service = {
      get: () => baseProfile,
      update: vi.fn(async () => {}),
    };

    await handler.execute(makeCtx(
      { writing_voice: { tone: ['confident', 'casual'] } },
      service,
    ));

    const updatedConfig = service.update.mock.calls[0][0] as ExecutiveProfile;
    expect(updatedConfig.writingVoice.tone).toEqual(['confident', 'casual']);
    // Other fields unchanged
    expect(updatedConfig.writingVoice.formality).toBe(50);
  });

  it('merges partial vocabulary update', async () => {
    const service = {
      get: () => baseProfile,
      update: vi.fn(async () => {}),
    };

    await handler.execute(makeCtx(
      { writing_voice: { vocabulary: { avoid: ['utilize', 'circle back'] } } },
      service,
    ));

    const updatedConfig = service.update.mock.calls[0][0] as ExecutiveProfile;
    // avoid updated, prefer unchanged
    expect(updatedConfig.writingVoice.vocabulary.avoid).toEqual(['utilize', 'circle back']);
    expect(updatedConfig.writingVoice.vocabulary.prefer).toEqual(['straightforward', 'folks']);
  });

  it('handles sign_off update (snake_case from YAML convention)', async () => {
    const service = {
      get: () => baseProfile,
      update: vi.fn(async () => {}),
    };

    await handler.execute(makeCtx(
      { writing_voice: { sign_off: 'Best, Joseph' } },
      service,
    ));

    const updatedConfig = service.update.mock.calls[0][0] as ExecutiveProfile;
    expect(updatedConfig.writingVoice.signOff).toBe('Best, Joseph');
  });

  it('includes changes description in output', async () => {
    const service = {
      get: () => baseProfile,
      update: vi.fn(async () => {}),
    };

    const result = await handler.execute(makeCtx(
      { writing_voice: { formality: 80 } },
      service,
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { changes: string };
      expect(data.changes).toContain('formality: 50 → 80');
    }
  });

  it('passes caller contactId as changedBy', async () => {
    const service = {
      get: () => baseProfile,
      update: vi.fn(async () => {}),
    };

    await handler.execute(makeCtx(
      { writing_voice: { formality: 30 } },
      service,
      { contactId: 'ceo-contact-uuid' },
    ));

    expect(service.update.mock.calls[0][1]).toBe('ceo-contact-uuid');
  });

  it('handles numeric string for formality (LLM may pass strings)', async () => {
    const service = {
      get: () => baseProfile,
      update: vi.fn(async () => {}),
    };

    await handler.execute(makeCtx(
      { writing_voice: { formality: '35' } },
      service,
    ));

    const updatedConfig = service.update.mock.calls[0][0] as ExecutiveProfile;
    expect(updatedConfig.writingVoice.formality).toBe(35);
  });

  it('returns changes as "no changes" when input matches current profile', async () => {
    const service = {
      get: () => baseProfile,
      update: vi.fn(async () => {}),
    };

    const result = await handler.execute(makeCtx(
      { writing_voice: { formality: 50 } },
      service,
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { changes: string };
      expect(data.changes).toBe('no changes');
    }
  });
});
