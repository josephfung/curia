// band-wiring.test.ts — boot check for band gating (#2159).
import { describe, expect, it, vi } from 'vitest';
import { checkBandGatingReady } from '../../../src/autonomy/band-wiring.js';
import type { EscalationJudge } from '../../../src/autonomy/escalation-judge.js';
import type { Logger } from '../../../src/logger.js';

function logger() {
  return { error: vi.fn(), info: vi.fn() } as unknown as Logger & { error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
}

describe('checkBandGatingReady', () => {
  it('logs an error when band gating has no enabled judge', () => {
    const log = logger();
    checkBandGatingReady('band', undefined, log);
    expect(log.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('band gating has no escalation judge'));
  });

  it('logs an error when the judge is wired but disabled', () => {
    const log = logger();
    checkBandGatingReady('band', { isEnabled: () => false } as unknown as EscalationJudge, log);
    expect(log.error).toHaveBeenCalled();
  });

  it('logs the effective gating at info when band is ready', () => {
    const log = logger();
    checkBandGatingReady('band', { isEnabled: () => true } as unknown as EscalationJudge, log);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith({ gating: 'band' }, expect.stringContaining('Autonomy gating: band'));
  });

  it('logs tier at info and nothing else', () => {
    const log = logger();
    checkBandGatingReady('tier', undefined, log);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith({ gating: 'tier' }, expect.stringContaining('Autonomy gating: tier'));
  });
});
