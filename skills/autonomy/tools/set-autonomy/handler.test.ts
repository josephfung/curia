// handler.test.ts — set-autonomy skill: the onboarding band limit (#2360)
import { describe, it, expect, vi } from 'vitest';
import { SetAutonomyHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';

function setup(score: number, openOnboarding: boolean) {
  const setScore = vi.fn(async (s: number) => ({ score: s, band: 'approval-required', previousScore: 50 }));
  const taskRepo = {
    listTasks: vi.fn(async () => (openOnboarding
      ? [{ id: 't1', parentTaskId: null, createdBy: 'onboarding' }]
      : [])),
  };
  const ctx = {
    input: { score },
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    caller: { role: 'principal', contactId: 'contact-123' },
    autonomyService: { setScore },
    taskRepo,
  } as unknown as ToolContext;
  return { ctx, setScore };
}

describe('SetAutonomyHandler onboarding band limit', () => {
  it('rejects an out-of-band score while onboarding is open', async () => {
    const { ctx, setScore } = setup(80, true);
    const r = await new SetAutonomyHandler().execute(ctx);
    expect(r).toEqual({
      success: false,
      error: 'During onboarding the independence level is 65 (Draft only), 75 (Ask first) or 85 (Spot-check).',
    });
    expect(setScore).not.toHaveBeenCalled();
  });

  it('accepts an in-band score while onboarding is open', async () => {
    const { ctx, setScore } = setup(75, true);
    const r = await new SetAutonomyHandler().execute(ctx);
    expect(r.success).toBe(true);
    expect(setScore).toHaveBeenCalled();
  });

  it('accepts any score when no onboarding task is open', async () => {
    const { ctx } = setup(80, false);
    const r = await new SetAutonomyHandler().execute(ctx);
    expect(r.success).toBe(true);
  });
});
