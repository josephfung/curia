/**
 * Unit test verifying DreamEngine calls workingMemory.purgeExpired()
 * after the decay pass commits — issue #220.
 */
import { describe, it, expect, vi } from 'vitest';
import { DreamEngine } from '../../../src/memory/dream-engine.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { WorkingMemory } from '../../../src/memory/working-memory.js';

function makeBus(): EventBus {
  return { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() } as unknown as EventBus;
}

function makeSilentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
}

function makePool() {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  };
  return {
    pool: {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    },
    client,
  };
}

const baseConfig = {
  intervalMs: 86_400_000,
  archiveThreshold: 0.05,
  halfLifeDays: { permanent: null as null, slow_decay: 180, fast_decay: 21 },
  edgeCountPercentile: 0.95,
  edgeCountFloor: 5,
  warnHoldBackDays: 7,
};

describe('DreamEngine — working memory purge', () => {
  it('calls purgeExpired() after the decay pass completes', async () => {
    const { pool } = makePool();
    const mockWorkingMemory = {
      purgeExpired: vi.fn().mockResolvedValue(3),
    } as unknown as WorkingMemory;

    const engine = new DreamEngine(
      pool as never,
      makeBus(),
      makeSilentLogger(),
      baseConfig,
      undefined,
      mockWorkingMemory,
    );

    await engine.runDecayPass();

    expect(mockWorkingMemory.purgeExpired).toHaveBeenCalledOnce();
  });

  it('does not throw when workingMemory is not injected', async () => {
    const { pool } = makePool();
    const engine = new DreamEngine(
      pool as never,
      makeBus(),
      makeSilentLogger(),
      baseConfig,
    );

    // Engine must complete the decay pass without error even though no
    // workingMemory was provided — the guard skips the purge step entirely.
    await expect(engine.runDecayPass()).resolves.toBeDefined();
  });

  it('logs a purge failure but does not throw', async () => {
    const { pool } = makePool();
    const logger = makeSilentLogger();
    const mockWorkingMemory = {
      purgeExpired: vi.fn().mockRejectedValue(new Error('DB connection lost')),
    } as unknown as WorkingMemory;

    const engine = new DreamEngine(
      pool as never,
      makeBus(),
      logger,
      baseConfig,
      undefined,
      mockWorkingMemory,
    );

    // Should not throw — purge failure is best-effort
    await expect(engine.runDecayPass()).resolves.toBeDefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('working memory purge failed'),
    );
  });
});
