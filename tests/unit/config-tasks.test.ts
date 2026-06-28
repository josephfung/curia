import { describe, it, expect } from 'vitest';
import { resolveTasksConfig, DEFAULT_TASKS_CONFIG, DEFAULT_RESUMABLE_CEILINGS } from '../../src/config.js';

describe('resolveTasksConfig', () => {
  it('returns defaults when no tasks block is present', () => {
    expect(resolveTasksConfig(undefined)).toEqual(DEFAULT_TASKS_CONFIG);
  });

  it('defaults are 60 / 5 / 4 / 48 / 30 with resumable ceilings', () => {
    expect(DEFAULT_TASKS_CONFIG).toEqual({
      heartbeatIntervalMinutes: 60,
      heartbeatMaxWakesPerTick: 5,
      idleThresholdHours: 4,
      staleWaitThresholdHours: 48,
      resumableContinuationSeconds: 30,
      resumableCeilings: DEFAULT_RESUMABLE_CEILINGS,
    });
  });

  it('overrides only the provided keys', () => {
    expect(resolveTasksConfig({ idleThresholdHours: 2 })).toEqual({
      heartbeatIntervalMinutes: 60,
      heartbeatMaxWakesPerTick: 5,
      idleThresholdHours: 2,
      staleWaitThresholdHours: 48,
      resumableContinuationSeconds: 30,
      resumableCeilings: DEFAULT_RESUMABLE_CEILINGS,
    });
  });

  it('merges resumableCeilings partial overrides', () => {
    expect(resolveTasksConfig({ resumableCeilings: { maxStalls: 5 } }).resumableCeilings).toEqual({
      ...DEFAULT_RESUMABLE_CEILINGS,
      maxStalls: 5,
    });
  });
});
