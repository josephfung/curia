import { describe, it, expect } from 'vitest';
import { ExecutiveProfileGetHandler } from '../../../skills/executive-profile-get/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import type { ExecutiveProfile } from '../../../src/executive/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

const testProfile: ExecutiveProfile = {
  writingVoice: {
    tone: ['direct', 'warm'],
    formality: 40,
    patterns: ['Short sentences', 'Uses em dashes freely'],
    vocabulary: {
      prefer: ['straightforward', 'folks'],
      avoid: ['leverage', 'synergy'],
    },
    signOff: '-- Joseph',
  },
};

function makeCtx(service?: { get: () => ExecutiveProfile }): SkillContext {
  return {
    input: {},
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    executiveProfileService: service as never,
  };
}

describe('ExecutiveProfileGetHandler', () => {
  const handler = new ExecutiveProfileGetHandler();

  it('returns failure when service is not available', async () => {
    const result = await handler.execute(makeCtx());
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('executiveProfileService');
  });

  it('returns the current profile and a summary', async () => {
    const service = { get: () => testProfile };
    const result = await handler.execute(makeCtx(service));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { profile: ExecutiveProfile; summary: string };
      expect(data.profile).toEqual(testProfile);
      expect(data.summary).toContain('direct, warm');
      expect(data.summary).toContain('40/100');
      expect(data.summary).toContain('Short sentences');
      expect(data.summary).toContain('straightforward, folks');
      expect(data.summary).toContain('leverage, synergy');
      expect(data.summary).toContain('-- Joseph');
    }
  });

  it('handles empty vocabulary gracefully', async () => {
    const emptyVocab: ExecutiveProfile = {
      writingVoice: {
        ...testProfile.writingVoice,
        vocabulary: { prefer: [], avoid: [] },
      },
    };
    const service = { get: () => emptyVocab };
    const result = await handler.execute(makeCtx(service));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { summary: string };
      expect(data.summary).not.toContain('Preferred words');
      expect(data.summary).not.toContain('Words to avoid');
    }
  });

  it('handles empty sign-off gracefully', async () => {
    const noSignOff: ExecutiveProfile = {
      writingVoice: { ...testProfile.writingVoice, signOff: '' },
    };
    const service = { get: () => noSignOff };
    const result = await handler.execute(makeCtx(service));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { summary: string };
      expect(data.summary).not.toContain('Sign-off');
    }
  });
});
