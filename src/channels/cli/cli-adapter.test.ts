import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CliAdapter } from './cli-adapter.js';
import { createSilentLogger } from '../../logger.js';
import type { EventBus } from '../../bus/bus.js';

// Mock readline to prevent stdin/stdout side effects during tests.
vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => ({
    on: vi.fn(),
    prompt: vi.fn(),
    close: vi.fn(),
  })),
  clearLine: vi.fn(),
  cursorTo: vi.fn(),
}));

function makeMockBus(): EventBus {
  return {
    subscribe: vi.fn(),
    publish: vi.fn().mockResolvedValue(undefined),
  } as unknown as EventBus;
}

describe('CliAdapter', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = makeMockBus();
  });

  it('subscribes to outbound.message on start', () => {
    const adapter = new CliAdapter(bus, createSilentLogger());
    adapter.start();
    expect(bus.subscribe).toHaveBeenCalledWith('outbound.message', 'channel', expect.any(Function));
  });

  it('does not subscribe to message.held', () => {
    const adapter = new CliAdapter(bus, createSilentLogger());
    adapter.start();
    expect(bus.subscribe).not.toHaveBeenCalledWith('message.held', expect.anything(), expect.anything());
  });
});
