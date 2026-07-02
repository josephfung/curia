import { describe, it, expect } from 'vitest';
import { computeDelegateTimeoutMs } from './delegate-timeout.js';

describe('computeDelegateTimeoutMs', () => {
  it('adds 25% headroom capped at three minutes', () => {
    expect(computeDelegateTimeoutMs(600)).toBe(750_000);
    expect(computeDelegateTimeoutMs(360)).toBe(450_000);
    expect(computeDelegateTimeoutMs(120)).toBe(150_000);
  });

  it('covers representative reconciliation duration with a 10-minute expected hint', () => {
    const nineMinutesMs = 9 * 60 * 1000;
    expect(computeDelegateTimeoutMs(600)).toBeGreaterThanOrEqual(nineMinutesMs);
  });

  it('rejects invalid duration hints', () => {
    expect(() => computeDelegateTimeoutMs(0)).toThrow(RangeError);
    expect(() => computeDelegateTimeoutMs(-1)).toThrow(RangeError);
    expect(() => computeDelegateTimeoutMs(Number.NaN)).toThrow(RangeError);
  });
});
