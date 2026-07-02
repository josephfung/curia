import { describe, it, expect } from 'vitest';
import {
  computeDelegateTimeoutMs,
  clampDelegateWaitTimeoutMs,
  DELEGATE_SKILL_OUTER_TIMEOUT_MS,
} from './delegate-timeout.js';

describe('computeDelegateTimeoutMs', () => {
  it('adds 25% headroom capped at three minutes', () => {
    expect(computeDelegateTimeoutMs(600)).toBe(750_000);
    expect(computeDelegateTimeoutMs(360)).toBe(450_000);
    expect(computeDelegateTimeoutMs(120)).toBe(150_000);
  });

  it('caps headroom at three minutes for long expected durations', () => {
    // 0.25 * 3000 = 750s of headroom, which exceeds the 180s cap.
    expect(computeDelegateTimeoutMs(3000)).toBe(DELEGATE_SKILL_OUTER_TIMEOUT_MS - 1);
  });

  it('clamps wait timeout strictly below delegate skill outer timeout', () => {
    // 800 + 180 = 980s would exceed the 900s outer skill budget.
    expect(computeDelegateTimeoutMs(800)).toBe(DELEGATE_SKILL_OUTER_TIMEOUT_MS - 1);
    // 720 + 180 = 900s exactly — must still stay below the outer timeout.
    expect(computeDelegateTimeoutMs(720)).toBe(DELEGATE_SKILL_OUTER_TIMEOUT_MS - 1);
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

describe('clampDelegateWaitTimeoutMs', () => {
  it('passes through values below the outer timeout', () => {
    expect(clampDelegateWaitTimeoutMs(750_000)).toBe(750_000);
  });

  it('rejects non-positive values', () => {
    expect(() => clampDelegateWaitTimeoutMs(0)).toThrow(RangeError);
  });
});
