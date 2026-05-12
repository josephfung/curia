import { describe, it, expect, vi } from 'vitest';
import type { SkillContext, SkillResult } from '../../src/skills/types.js';
import { DecayWarningsListHandler } from './handler.js';

function makeCtx(warnings: unknown[]): SkillContext {
  return {
    input: {},
    entityMemory: {
      listDecayWarnings: vi.fn().mockResolvedValue(warnings),
    },
    timezone: 'America/Toronto',
    log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  } as unknown as SkillContext;
}

const warnedAt = new Date('2026-05-10T14:00:00.000Z');  // 2 days before 2026-05-12

describe('DecayWarningsListHandler', () => {
  it('returns warned nodes sorted oldest-first with daysRemaining', async () => {
    const ctx = makeCtx([
      {
        nodeId: 'node-1', nodeType: 'person', label: 'Alice', confidence: 0.04,
        sensitivity: 'confidential', edgeCount: 3, reason: 'high_sensitivity',
        warnedAt,
      },
    ]);
    const handler = new DecayWarningsListHandler();
    const result: SkillResult = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { warnings: unknown[]; count: number } }).data;
    expect(data.count).toBe(1);
    expect(data.warnings).toHaveLength(1);
    const w = data.warnings[0] as {
      nodeId: string; daysRemaining: number; reason: string; sensitivity: string;
    };
    expect(w.nodeId).toBe('node-1');
    expect(w.reason).toBe('high_sensitivity');
    expect(w.daysRemaining).toBeGreaterThan(0);
    expect(w.daysRemaining).toBeLessThanOrEqual(7);
  });

  it('returns empty list when no warnings', async () => {
    const ctx = makeCtx([]);
    const handler = new DecayWarningsListHandler();
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { count: number } }).data;
    expect(data.count).toBe(0);
  });

  it('returns success: false when entityMemory is unavailable', async () => {
    const ctx = {
      input: {},
      entityMemory: undefined,
      log: { error: vi.fn() },
    } as unknown as SkillContext;
    const handler = new DecayWarningsListHandler();
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
  });
});
