import { describe, it, expect, vi } from 'vitest';
import { Scheduler } from '../../../src/scheduler/scheduler.js';

describe('Scheduler.lastTickAt', () => {
  it('starts as null', () => {
    const scheduler = new Scheduler({
      pool: {} as never,
      bus: { subscribe: vi.fn(), publish: vi.fn() } as never,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
      schedulerService: {} as never,
    });
    expect(scheduler.lastTickAt).toBeNull();
  });
});
