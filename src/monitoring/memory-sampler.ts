// memory-sampler.ts — periodically log process.memoryUsage() so heap growth is
// measurable in production without capturing a heap snapshot.
//
// Why this exists (#1650): prod OOM-restarts every ~4h41m on a steady JS-heap
// leak. This sampler surfaces the memory breakdown over time so we can tell
// *what kind* of memory is growing:
//   - external / arrayBuffers climbing  → native/fetch response buffers retained
//     (points at the SDK / undici layer on the non-streaming LLM path)
//   - heapUsed climbing                 → JS objects retained
// It is cheap and safe on RAM-constrained hosts (no heap serialization), unlike a
// snapshot. One sample fires at boot for a baseline, then every `intervalMs`.
//
// TODO(#1650): temporary diagnostic — remove this sampler (and its wiring in
// index.ts) once the leak class is characterized. It should not become a
// permanent subsystem.

import type { Logger } from '../logger.js';

/** Default cadence. 60s charts a ~300 MB/hr climb clearly at negligible cost. */
const DEFAULT_SAMPLE_INTERVAL_MS = 60_000;

export interface MemorySamplerConfig {
  logger: Logger;
  /** Sample cadence. Default 60s. */
  intervalMs?: number;
  /** Override setInterval/clearInterval for tests. */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export class MemorySampler {
  private readonly log: Logger;
  private readonly intervalMs: number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: MemorySamplerConfig) {
    this.log = config.logger.child({ component: 'memory-sampler' });
    this.intervalMs = config.intervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    this.setIntervalFn = config.setIntervalFn ?? setInterval;
    this.clearIntervalFn = config.clearIntervalFn ?? clearInterval;
  }

  /** Emit a single memory sample. Exposed for tests; production uses start().
   *
   *  Best-effort by design: this diagnostic must never crash the process it
   *  measures (#1650). The sampler runs on a RAM-constrained host that is
   *  already OOM-looping, so an allocation could plausibly throw inside pino
   *  serialization under exactly the memory pressure we're chasing. A synchronous
   *  throw from the interval callback would be an uncaught exception (no
   *  uncaughtException handler exists) and would terminate the process — turning
   *  the diagnostic into a second crash source that masks the real OOM signal.
   *  So a failed sample escalates to a *guarded* warn (still observable) and
   *  never propagates. */
  sample(): void {
    try {
      const mem = process.memoryUsage();
      this.log.info(
        {
          rssBytes: mem.rss,
          heapUsedBytes: mem.heapUsed,
          heapTotalBytes: mem.heapTotal,
          externalBytes: mem.external,
          arrayBuffersBytes: mem.arrayBuffers,
          uptimeS: Math.round(process.uptime()),
        },
        'Process memory sample',
      );
    } catch (err) {
      // memoryUsage()/info() failed. Keep it observable via a *guarded* warn:
      // the fallback log itself must not throw either, or we reintroduce the
      // very crash path we are guarding against.
      this.neverThrow(() => this.log.warn({ err }, 'Memory sample failed — continuing'));
    }
  }

  /** Start periodic sampling. Idempotent. */
  start(): void {
    if (this.timer !== null) return;
    // Guarded: index.ts calls start() directly during bootstrap, so a logging
    // failure here must not propagate to main() and abort boot.
    this.neverThrow(() => this.log.info({ intervalMs: this.intervalMs }, 'MemorySampler started'));
    // One immediate sample so the boot baseline is captured without waiting a
    // full interval.
    this.sample();
    this.timer = this.setIntervalFn(() => this.sample(), this.intervalMs);
    // Unref so the sampler never keeps the process alive during clean shutdown.
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
  }

  /** Stop periodic sampling. Idempotent. */
  stop(): void {
    if (this.timer === null) return;
    this.clearIntervalFn(this.timer);
    this.timer = null;
    this.neverThrow(() => this.log.info('MemorySampler stopped'));
  }

  /**
   * Run a logging call that can never be allowed to throw.
   *
   * DELIBERATE, DOCUMENTED EXCEPTION to the repo rule that every catch must log,
   * audit, and propagate (CLAUDE.md → Error Handling). Rationale, and the
   * "audit path" for this exception:
   *   - This is a best-effort diagnostic whose whole job is to stay alive on a
   *     host that is already OOM-looping (#1650). Propagating a logging failure
   *     would make it a SECOND crash source and mask the real OOM signal — the
   *     opposite of its purpose.
   *   - The thing that fails here is the logger itself, so there is no reliable
   *     surface left to re-log on. Audit path: none, by design — a lost
   *     telemetry line is acceptable data loss; a crashed process is not.
   * Swallow at the lowest possible level so no caller (sample/start/stop) can be
   * taken down by a log call.
   */
  private neverThrow(logCall: () => void): void {
    try {
      logCall();
    } catch {
      // Logger unusable (see method doc). Intentionally not re-logged or
      // re-thrown: there is nothing left that could safely report it.
    }
  }
}
