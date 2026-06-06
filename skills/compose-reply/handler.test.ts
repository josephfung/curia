import { describe, it, expect } from 'vitest';
import { ComposeReplyHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import { createLogger } from '../../src/logger.js';

function makeCtx(input: Record<string, unknown>): SkillContext {
  return {
    input,
    agentId: 'coordinator',
    conversationId: 'conv-test',
    taskEventId: 'task-test',
    log: createLogger('silent'),
    secret: () => { throw new Error('no secrets'); },
    timezone: 'UTC',
  } as unknown as SkillContext;
}

describe('ComposeReplyHandler', () => {
  const handler = new ComposeReplyHandler();

  it('returns external and internal when both are provided', async () => {
    const ctx = makeCtx({ external: 'Friday works great!', internal: 'Confirmed 2 PM with Armin; invite pending.' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as { external: string; internal?: string };
    expect(data.external).toBe('Friday works great!');
    expect(data.internal).toBe('Confirmed 2 PM with Armin; invite pending.');
  });

  it('returns only external when internal is absent', async () => {
    const ctx = makeCtx({ external: 'See you then!' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as { external: string; internal?: string };
    expect(data.external).toBe('See you then!');
    expect(data.internal).toBeUndefined();
  });

  it('trims whitespace from external', async () => {
    const ctx = makeCtx({ external: '  Hello there.  ' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as { external: string }).external).toBe('Hello there.');
  });

  it('trims whitespace from internal when present', async () => {
    const ctx = makeCtx({ external: 'Hi Armin', internal: '  Status update.  ' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as { internal?: string }).internal).toBe('Status update.');
  });

  it('fails when external is missing', async () => {
    const ctx = makeCtx({});
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/external/i);
  });

  it('fails when external is not a string', async () => {
    const ctx = makeCtx({ external: 42 });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/external/i);
  });

  it('fails when external is empty after trimming', async () => {
    const ctx = makeCtx({ external: '   ' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/external/i);
  });

  it('fails when internal is provided but is not a string', async () => {
    const ctx = makeCtx({ external: 'Valid reply', internal: 123 });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/internal/i);
  });

  it('fails when internal is provided but is empty after trimming', async () => {
    const ctx = makeCtx({ external: 'Valid reply', internal: '   ' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/internal/i);
  });
});
