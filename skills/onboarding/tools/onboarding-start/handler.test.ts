import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { OnboardingStartHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { StartResult } from '../../../../src/onboarding/onboarding-service.js';

const logger = pino({ level: 'silent' });

function run(result: StartResult, channelId?: string) {
  const onboardingService = { start: vi.fn(async () => result) };
  const out = new OnboardingStartHandler().execute({
    input: {},
    log: logger,
    onboardingService,
    ...(channelId ? { channelId } : {}),
  } as unknown as ToolContext);
  return { out, onboardingService };
}

describe('onboarding-start', () => {
  it('starts as the principal, confirming a working principal', async () => {
    const { out, onboardingService } = run({ ok: true, taskId: 'task-1', invitation: null, restartScheduled: false });
    const result = await out;
    expect(result.success).toBe(true);
    expect(onboardingService.start).toHaveBeenCalledWith({ actor: 'principal', confirmWorkingPrincipal: true });
  });

  it("passes the turn's channel, so a start from another channel rotates the web thread", async () => {
    const { out, onboardingService } = run({ ok: true, taskId: 'task-1', invitation: null, restartScheduled: false }, 'signal');
    await out;
    expect(onboardingService.start).toHaveBeenCalledWith({ actor: 'principal', confirmWorkingPrincipal: true, channelId: 'signal' });
  });

  it('fails when onboarding is already under way', async () => {
    const result = await run({ ok: false, code: 'already_started' }).out;
    expect(result.success).toBe(false);
  });
});
