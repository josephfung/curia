// handler.test.ts — tests for get-autonomy trend surfacing (Phase 3).
// Verifies that lastSetBy, trend, and scoredActionCount are returned in the response data.
import { describe, it, expect, vi } from 'vitest';
import { GetAutonomyHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import { createSilentLogger } from '../../src/logger.js';

// Default service stubs — override per-test via makeCtx(serviceOverrides)
const defaultService = {
  getConfig: vi.fn().mockResolvedValue({
    score: 78,
    band: 'approval-required',
    updatedAt: new Date('2026-05-03'),
    updatedBy: 'system',
  }),
  getHistory: vi.fn().mockResolvedValue([
    { id: 3, score: 78, previousScore: 75, band: 'approval-required', changedBy: 'system', reason: 'auto-adjust: +3', changedAt: new Date('2026-05-03') },
    { id: 2, score: 75, previousScore: 75, band: 'approval-required', changedBy: 'ceo', reason: 'starting point', changedAt: new Date('2026-04-28') },
  ]),
  getScoredActionCount: vi.fn().mockResolvedValue(47),
};

function makeCtx(serviceOverrides: Partial<typeof defaultService> = {}): SkillContext {
  // Spread defaults then apply overrides — each test gets a fresh merged service mock
  const autonomyService = { ...defaultService, ...serviceOverrides };
  return {
    input: {},
    log: createSilentLogger(),
    autonomyService,
  } as unknown as SkillContext;
}

describe('GetAutonomyHandler', () => {
  it('includes lastSetBy in the response data', async () => {
    const ctx = makeCtx();
    const handler = new GetAutonomyHandler();
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    // lastSetBy should reflect the most recent history entry's changedBy
    expect((result as any).data.lastSetBy).toBe('system');
  });

  it('includes scoredActionCount in the response data', async () => {
    const ctx = makeCtx();
    const handler = new GetAutonomyHandler();
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect((result as any).data.scoredActionCount).toBe(47);
  });

  it('reports trend as improving when last system score > previous system score', async () => {
    // Two system entries: latest scored higher than the one before it
    const ctx = makeCtx({
      getHistory: vi.fn().mockResolvedValue([
        { id: 4, score: 78, previousScore: 75, band: 'approval-required', changedBy: 'system', reason: 'auto-adjust: +3', changedAt: new Date('2026-05-03') },
        { id: 3, score: 75, previousScore: 72, band: 'approval-required', changedBy: 'system', reason: 'auto-adjust: +3', changedAt: new Date('2026-05-02') },
        { id: 2, score: 72, previousScore: 75, band: 'approval-required', changedBy: 'ceo', reason: 'starting point', changedAt: new Date('2026-04-28') },
      ]),
    });
    const handler = new GetAutonomyHandler();
    const result = await handler.execute(ctx);
    expect((result as any).data.trend).toBe('improving');
  });

  it('reports trend as declining when last system score < previous system score', async () => {
    // Two system entries: latest scored lower than the one before it
    const ctx = makeCtx({
      getHistory: vi.fn().mockResolvedValue([
        { id: 4, score: 72, previousScore: 75, band: 'approval-required', changedBy: 'system', reason: 'auto-adjust: -3', changedAt: new Date('2026-05-03') },
        { id: 3, score: 75, previousScore: 78, band: 'approval-required', changedBy: 'system', reason: 'auto-adjust: -3', changedAt: new Date('2026-05-02') },
      ]),
    });
    const handler = new GetAutonomyHandler();
    const result = await handler.execute(ctx);
    expect((result as any).data.trend).toBe('declining');
  });

  it('reports trend as null when fewer than 2 system entries', async () => {
    // Only one entry and it's from ceo, not system — no trend can be computed
    const ctx = makeCtx({
      getHistory: vi.fn().mockResolvedValue([
        { id: 1, score: 75, previousScore: null, band: 'approval-required', changedBy: 'ceo', reason: 'starting point', changedAt: new Date('2026-04-28') },
      ]),
    });
    const handler = new GetAutonomyHandler();
    const result = await handler.execute(ctx);
    expect((result as any).data.trend).toBeNull();
  });
});
