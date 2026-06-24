import { describe, it, expect } from 'vitest';
import { resolveHealthConfig } from '../../../src/config.js';

describe('resolveHealthConfig', () => {
  it('returns defaults for undefined input', () => {
    const config = resolveHealthConfig(undefined);
    expect(config.liveness.emailStallFactor).toBe(3);
    expect(config.liveness.schedulerMaxTickS).toBe(120);
    expect(config.canarySchedule).toBe('0 6 * * *');
    expect(config.heartbeats.llm_fast).toBeNull();
  });

  it('accepts valid heartbeat URLs', () => {
    const config = resolveHealthConfig({
      liveness: { email_stall_factor: 5, scheduler_max_tick_s: 60 },
      canary_schedule: '0 8 * * *',
      heartbeats: { llm_fast: 'https://uptime.betterstack.com/api/v1/heartbeat/abc123' },
    });
    expect(config.heartbeats.llm_fast).toBe('https://uptime.betterstack.com/api/v1/heartbeat/abc123');
    expect(config.liveness.emailStallFactor).toBe(5);
  });

  it('nulls out non-https heartbeat URLs with a warning (no throw)', () => {
    // Should not throw — just silently null out the bad URL.
    const config = resolveHealthConfig({
      heartbeats: { nylas: 'http://insecure.example.com/heartbeat' },
    });
    expect(config.heartbeats.nylas).toBeNull();
  });

  it('nulls out invalid heartbeat URLs', () => {
    const config = resolveHealthConfig({
      heartbeats: { signal: 'not-a-url' },
    });
    expect(config.heartbeats.signal).toBeNull();
  });
});
