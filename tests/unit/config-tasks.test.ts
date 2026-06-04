import { describe, it, expect } from 'vitest';
import { resolveTasksConfig, DEFAULT_TASKS_CONFIG } from '../../src/config.js';

describe('resolveTasksConfig', () => {
  it('returns defaults when no tasks block is present', () => {
    expect(resolveTasksConfig(undefined)).toEqual(DEFAULT_TASKS_CONFIG);
  });

  it('defaults are 60 / 5 / 4 / 48', () => {
    expect(DEFAULT_TASKS_CONFIG).toEqual({
      heartbeatIntervalMinutes: 60,
      heartbeatMaxWakesPerTick: 5,
      idleThresholdHours: 4,
      staleWaitThresholdHours: 48,
    });
  });

  it('overrides only the provided keys', () => {
    expect(resolveTasksConfig({ idleThresholdHours: 2 })).toEqual({
      heartbeatIntervalMinutes: 60,
      heartbeatMaxWakesPerTick: 5,
      idleThresholdHours: 2,
      staleWaitThresholdHours: 48,
    });
  });
});
