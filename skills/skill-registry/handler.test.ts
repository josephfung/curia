import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { SkillRegistryHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';

function makeCtx(overrides: Partial<SkillContext> = {}): SkillContext {
  return {
    input: { query: '' },
    secret: () => 'unused',
    log: pino({ level: 'silent' }),
    ...overrides,
  } as unknown as SkillContext;
}

describe('SkillRegistryHandler', () => {
  it('returns error when skillSearch is not injected', async () => {
    const handler = new SkillRegistryHandler();
    const ctx = makeCtx({ skillSearch: undefined });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/skillSearch not available/);
  });

  it('calls skillSearch with the provided query and returns results', async () => {
    const handler = new SkillRegistryHandler();
    const mockResults = [
      { name: 'email-send', description: 'Send an email' },
      { name: 'email-reply', description: 'Reply to an email' },
    ];
    const skillSearch = vi.fn().mockReturnValue(mockResults);
    const ctx = makeCtx({ input: { query: 'email' }, skillSearch });

    const result = await handler.execute(ctx);

    expect(skillSearch).toHaveBeenCalledWith('email');
    expect(result).toEqual({ success: true, data: { skills: mockResults } });
  });

  it('passes an empty string to skillSearch when query is empty', async () => {
    const handler = new SkillRegistryHandler();
    const skillSearch = vi.fn().mockReturnValue([]);
    const ctx = makeCtx({ input: { query: '' }, skillSearch });

    const result = await handler.execute(ctx);

    expect(skillSearch).toHaveBeenCalledWith('');
    expect(result).toEqual({ success: true, data: { skills: [] } });
  });
});
