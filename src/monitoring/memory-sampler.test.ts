import { describe, it, expect, vi } from 'vitest';
import { MemorySampler } from './memory-sampler.js';
import type { Logger } from '../logger.js';

interface CapturedLog {
  obj: Record<string, unknown> | undefined;
  msg: string;
}

/** Minimal pino-shaped logger that captures info() calls. Only the subset the
 *  sampler uses is implemented; cast through unknown per repo convention. */
function makeCapturingLogger(): { logger: Logger; infos: CapturedLog[] } {
  const infos: CapturedLog[] = [];
  const record = (objOrMsg: unknown, msg?: string): void => {
    if (typeof objOrMsg === 'string') infos.push({ obj: undefined, msg: objOrMsg });
    else infos.push({ obj: objOrMsg as Record<string, unknown>, msg: msg ?? '' });
  };
  const stub = {
    info: record,
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => stub,
  };
  return { logger: stub as unknown as Logger, infos };
}

function fakeTimer(): NodeJS.Timeout {
  return { unref: vi.fn() } as unknown as NodeJS.Timeout;
}

describe('MemorySampler', () => {
  it('sample() logs the memoryUsage breakdown including arrayBuffers/external', () => {
    const { logger, infos } = makeCapturingLogger();
    const sampler = new MemorySampler({ logger });

    sampler.sample();

    const sample = infos.find((l) => l.msg === 'Process memory sample');
    expect(sample).toBeDefined();
    for (const key of ['rssBytes', 'heapUsedBytes', 'externalBytes', 'arrayBuffersBytes'] as const) {
      expect(typeof sample!.obj?.[key]).toBe('number');
    }
  });

  it('sample() swallows a logger failure so it can never crash the process under diagnosis', () => {
    // Simulates an allocation failure inside pino under the memory pressure the
    // sampler exists to measure (#1650): info() throws. sample() must not
    // propagate, and the failure must still be observable (warn()).
    const warn = vi.fn();
    const throwingLogger = {
      info: () => {
        throw new Error('serialize failed');
      },
      warn,
      error: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
      child() {
        return this;
      },
    };
    const sampler = new MemorySampler({ logger: throwingLogger as unknown as Logger });

    expect(() => sampler.sample()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('sample() never propagates even when the fallback warn() also throws', () => {
    // Worst case under memory pressure (#1650): both info() and the guarded
    // warn() fallback throw. The sampler must STILL not take down the process
    // it is measuring — a second crash source would mask the real OOM signal.
    const brokenLogger = {
      info: () => {
        throw new Error('info failed');
      },
      warn: () => {
        throw new Error('warn failed');
      },
      error: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
      child() {
        return this;
      },
    };
    const sampler = new MemorySampler({ logger: brokenLogger as unknown as Logger });

    expect(() => sampler.sample()).not.toThrow();
  });

  it('start() does not abort bootstrap when the startup log throws — it still schedules sampling', () => {
    // index.ts calls start() directly during bootstrap; a logging failure here
    // must not propagate to main() and kill boot (#1650). start() must swallow
    // the failed "started" line (and the failed baseline sample) and still arm
    // the interval timer.
    const infoThrows = {
      info: () => {
        throw new Error('startup log failed');
      },
      warn: vi.fn(),
      error: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
      child() {
        return this;
      },
    };
    const timer = fakeTimer();
    const setIntervalFn = vi.fn(() => timer);
    const sampler = new MemorySampler({
      logger: infoThrows as unknown as Logger,
      setIntervalFn: setIntervalFn as unknown as typeof setInterval,
    });

    expect(() => sampler.start()).not.toThrow();
    // Continued past the failed log + failed baseline sample to arm the timer.
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(timer.unref).toHaveBeenCalledTimes(1);
  });

  it("start() emits a baseline sample immediately and schedules the interval (unref'd)", () => {
    const { logger, infos } = makeCapturingLogger();
    const timer = fakeTimer();
    let scheduled: (() => void) | undefined;
    let scheduledMs: number | undefined;
    const setIntervalFn = vi.fn((callback: () => void, ms: number) => {
      scheduled = callback;
      scheduledMs = ms;
      return timer;
    });
    const sampler = new MemorySampler({
      logger,
      intervalMs: 30_000,
      setIntervalFn: setIntervalFn as unknown as typeof setInterval,
    });

    sampler.start();

    // Baseline sample fires at boot.
    expect(infos.filter((l) => l.msg === 'Process memory sample')).toHaveLength(1);
    // Scheduled at the configured cadence and unref'd so it can't block shutdown.
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(scheduledMs).toBe(30_000);
    expect(timer.unref).toHaveBeenCalledTimes(1);

    // Firing the scheduled callback emits another sample.
    expect(scheduled).toBeDefined();
    scheduled!();
    expect(infos.filter((l) => l.msg === 'Process memory sample')).toHaveLength(2);
  });

  it('start() is idempotent and stop() clears the timer', () => {
    const { logger } = makeCapturingLogger();
    const timer = fakeTimer();
    const setIntervalFn = vi.fn(() => timer);
    const clearIntervalFn = vi.fn();
    const sampler = new MemorySampler({
      logger,
      setIntervalFn: setIntervalFn as unknown as typeof setInterval,
      clearIntervalFn: clearIntervalFn as unknown as typeof clearInterval,
    });

    sampler.stop(); // no-op before start
    sampler.start();
    sampler.start(); // idempotent — must not schedule a second timer
    expect(setIntervalFn).toHaveBeenCalledTimes(1);

    sampler.stop();
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(clearIntervalFn).toHaveBeenCalledWith(timer);
  });
});
