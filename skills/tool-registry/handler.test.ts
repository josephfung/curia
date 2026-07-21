import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { ToolRegistryHandler } from './handler.js';
import type { ToolContext } from '../../src/skills/types.js';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    input: { query: '' },
    secret: () => 'unused',
    log: pino({ level: 'silent' }),
    ...overrides,
  } as unknown as ToolContext;
}

describe('ToolRegistryHandler', () => {
  it('returns error when toolSearch is not injected', async () => {
    const handler = new ToolRegistryHandler();
    const ctx = makeCtx({ toolSearch: undefined });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/toolSearch not available/);
  });

  it('calls toolSearch with the provided query and returns results', async () => {
    const handler = new ToolRegistryHandler();
    const mockResults = [
      { name: 'email-send', description: 'Send an email' },
      { name: 'email-reply', description: 'Reply to an email' },
    ];
    const toolSearch = vi.fn().mockReturnValue(mockResults);
    const ctx = makeCtx({ input: { query: 'email' }, toolSearch });

    const result = await handler.execute(ctx);

    expect(toolSearch).toHaveBeenCalledWith('email');
    expect(result).toEqual({ success: true, data: { tools: mockResults } });
  });

  it('returns error when toolSearch throws', async () => {
    const handler = new ToolRegistryHandler();
    const toolSearch = vi.fn().mockImplementation(() => { throw new Error('registry corrupted'); });
    const ctx = makeCtx({ input: { query: 'email' }, toolSearch });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/registry corrupted/);
  });

  it('passes an empty string to toolSearch when query is empty', async () => {
    const handler = new ToolRegistryHandler();
    const toolSearch = vi.fn().mockReturnValue([]);
    const ctx = makeCtx({ input: { query: '' }, toolSearch });

    const result = await handler.execute(ctx);

    expect(toolSearch).toHaveBeenCalledWith('');
    expect(result).toEqual({ success: true, data: { tools: [] } });
  });
});
