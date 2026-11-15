import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { TurnHandoffHandler } from './handler.js';
import type { ToolContext } from '../../src/skills/types.js';

function makeCtx(input: Record<string, unknown>): ToolContext {
  return {
    input,
    secret: () => 'test-key',
    log: pino({ level: 'silent' }),
  } as unknown as ToolContext;
}

describe('turn-handoff handler', () => {
  const handler = new TurnHandoffHandler();

  it('returns the hand-off request marker for the runtime', async () => {
    const result = await handler.execute(makeCtx({ turn_id: '  root-123  ' }));
    expect(result).toEqual({ success: true, data: { handoff_requested: true, turn_id: 'root-123' } });
  });

  it('rejects a missing turn_id', async () => {
    const result = await handler.execute(makeCtx({}));
    expect(result.success).toBe(false);
  });

  it('rejects a blank or non-string turn_id', async () => {
    expect((await handler.execute(makeCtx({ turn_id: '   ' }))).success).toBe(false);
    expect((await handler.execute(makeCtx({ turn_id: 42 }))).success).toBe(false);
  });

  it('rejects an over-long turn_id', async () => {
    const result = await handler.execute(makeCtx({ turn_id: 'x'.repeat(201) }));
    expect(result.success).toBe(false);
  });
});
