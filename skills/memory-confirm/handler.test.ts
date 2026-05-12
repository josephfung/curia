import { describe, it, expect, vi } from 'vitest';
import type { SkillContext } from '../../src/skills/types.js';
import { MemoryConfirmHandler } from './handler.js';

function makeCtx(
  action: string,
  nodeId: string,
  confirmResult: { success: boolean; label?: string },
  dismissResult: { success: boolean; label?: string },
): SkillContext {
  return {
    input: { nodeId, action },
    entityMemory: {
      confirmDecayWarning: vi.fn().mockResolvedValue(confirmResult),
      dismissDecayWarning: vi.fn().mockResolvedValue(dismissResult),
    },
    log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  } as unknown as SkillContext;
}

describe('MemoryConfirmHandler', () => {
  it('confirm action resets the node and returns success', async () => {
    const ctx = makeCtx('confirm', 'node-1',
      { success: true, label: 'Alice' },
      { success: false },
    );
    const handler = new MemoryConfirmHandler();
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { action: string; label: string; nodeId: string } }).data;
    expect(data.action).toBe('confirmed');
    expect(data.label).toBe('Alice');
    expect(data.nodeId).toBe('node-1');
    expect(ctx.entityMemory!.confirmDecayWarning).toHaveBeenCalledWith('node-1');
    expect(ctx.entityMemory!.dismissDecayWarning).not.toHaveBeenCalled();
  });

  it('dismiss action archives the node and returns success', async () => {
    const ctx = makeCtx('dismiss', 'node-2',
      { success: false },
      { success: true, label: 'Budget 2025' },
    );
    const handler = new MemoryConfirmHandler();
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { action: string } }).data;
    expect(data.action).toBe('dismissed');
    expect(ctx.entityMemory!.dismissDecayWarning).toHaveBeenCalledWith('node-2');
    expect(ctx.entityMemory!.confirmDecayWarning).not.toHaveBeenCalled();
  });

  it('returns success: false when node is not in warned state', async () => {
    const ctx = makeCtx('confirm', 'node-3',
      { success: false },
      { success: false },
    );
    const handler = new MemoryConfirmHandler();
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
  });

  it('returns success: false for unknown action', async () => {
    const ctx = makeCtx('delete', 'node-1', { success: true, label: 'X' }, { success: true, label: 'X' });
    const handler = new MemoryConfirmHandler();
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/invalid action/i);
  });

  it('returns success: false when entityMemory is unavailable', async () => {
    const ctx = {
      input: { nodeId: 'n', action: 'confirm' },
      entityMemory: undefined,
      log: { error: vi.fn() },
    } as unknown as SkillContext;
    const handler = new MemoryConfirmHandler();
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
  });
});
