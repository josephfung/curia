// canary-schedule.test.ts — the health canaries fire at health.canary_schedule (#2229).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CanarySchedule } from '../../../src/health/canary-schedule.js';
import { HealthService } from '../../../src/health/health-service.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createSilentLogger, type Logger } from '../../../src/logger.js';
import { DEFAULT_HEALTH_CONFIG } from '../../../src/config.js';
import type { CanaryResult } from '../../../src/health/types.js';
import type { Pool } from 'pg';

const DAILY_6AM = '0 6 * * *';

function makeSchedule(overrides: Partial<ConstructorParameters<typeof CanarySchedule>[0]> = {}) {
  const runCanaries = vi.fn<() => Promise<CanaryResult[]>>().mockResolvedValue([]);
  const schedule = new CanarySchedule({
    cron: DAILY_6AM,
    timezone: 'UTC',
    runCanaries,
    logger: createSilentLogger(),
    ...overrides,
  });
  return { schedule, runCanaries: (overrides.runCanaries ?? runCanaries) as typeof runCanaries };
}

describe('CanarySchedule', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T05:59:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires at the scheduled time and not before', async () => {
    const { schedule, runCanaries } = makeSchedule();
    schedule.start();

    await vi.advanceTimersByTimeAsync(59_000);
    expect(runCanaries).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runCanaries).toHaveBeenCalledOnce();
    schedule.stop();
  });

  it('fires once per scheduled time, every day', async () => {
    const { schedule, runCanaries } = makeSchedule();
    schedule.start();

    await vi.advanceTimersByTimeAsync(60_000 + 3 * 24 * 3_600_000);
    expect(runCanaries).toHaveBeenCalledTimes(4);
    schedule.stop();
  });

  it('fires once per slot on an every-minute schedule', async () => {
    const { schedule, runCanaries } = makeSchedule({ cron: '* * * * *' });
    schedule.start();

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(runCanaries).toHaveBeenCalledTimes(3);
    schedule.stop();
  });

  it('after a restart, runs at the next scheduled time and not again for one already served', async () => {
    const first = makeSchedule();
    first.schedule.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first.runCanaries).toHaveBeenCalledOnce();
    first.schedule.stop();

    // Restart at 06:05: today's 06:00 slot is behind us.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const second = makeSchedule();
    second.schedule.start();

    await vi.advanceTimersByTimeAsync(23 * 3_600_000);
    expect(second.runCanaries).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(55 * 60_000);
    expect(second.runCanaries).toHaveBeenCalledOnce();
    second.schedule.stop();
  });

  it('start() twice arms one timer', async () => {
    const { schedule, runCanaries } = makeSchedule();
    schedule.start();
    schedule.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runCanaries).toHaveBeenCalledOnce();
    schedule.stop();
  });

  it('interprets the cron in the configured timezone', async () => {
    // 06:00 in Toronto is 10:00 UTC in October (EDT).
    const { schedule, runCanaries } = makeSchedule({ timezone: 'America/Toronto' });
    schedule.start();

    await vi.advanceTimersByTimeAsync(4 * 3_600_000);
    expect(runCanaries).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runCanaries).toHaveBeenCalledOnce();
    schedule.stop();
  });

  it('skips a slot while the previous run is still in flight', async () => {
    let release: () => void = () => {};
    const runCanaries = vi.fn<() => Promise<CanaryResult[]>>().mockImplementation(
      () => new Promise((resolve) => { release = () => resolve([]); }),
    );
    const { schedule } = makeSchedule({ cron: '* * * * *', runCanaries });
    schedule.start();

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(runCanaries).toHaveBeenCalledOnce();

    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runCanaries).toHaveBeenCalledTimes(2);
    schedule.stop();
  });

  it('keeps firing after a run rejects', async () => {
    const runCanaries = vi.fn<() => Promise<CanaryResult[]>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue([]);
    const { schedule } = makeSchedule({ cron: '* * * * *', runCanaries });
    schedule.start();

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(runCanaries).toHaveBeenCalledTimes(2);
    schedule.stop();
  });

  it('does not fire after stop()', async () => {
    const { schedule, runCanaries } = makeSchedule();
    schedule.start();
    schedule.stop();

    await vi.advanceTimersByTimeAsync(2 * 24 * 3_600_000);
    expect(runCanaries).not.toHaveBeenCalled();
  });

  it('waits out a schedule further away than the longest setTimeout', async () => {
    // Yearly, on 1 January: more than 2^31-1 ms away from 21 October.
    const { schedule, runCanaries } = makeSchedule({ cron: '0 6 1 1 *' });
    schedule.start();

    await vi.advanceTimersByTimeAsync(30 * 24 * 3_600_000);
    expect(runCanaries).not.toHaveBeenCalled();

    vi.setSystemTime(new Date('2027-01-01T05:59:00Z'));
    await vi.advanceTimersByTimeAsync(80 * 24 * 3_600_000);
    expect(runCanaries).toHaveBeenCalledOnce();
    schedule.stop();
  });

  it('throws on an invalid cron, so a bad health.canary_schedule fails boot', () => {
    expect(() => makeSchedule({ cron: 'not a cron' })).toThrow();
  });

  it('throws on an invalid timezone', () => {
    expect(() => makeSchedule({ timezone: 'Not/AZone' })).toThrow();
  });
});

describe('CanarySchedule driving HealthService.runCanaries', () => {
  const HEARTBEAT = 'https://uptime.example.com/api/v1/heartbeat/tavily';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T05:59:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('logs one Health canary result per canary and pings the heartbeat of an ok canary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const logger = createSilentLogger();
    const info = vi.spyOn(logger, 'info');
    const error = vi.spyOn(logger, 'error');
    const healthService = new HealthService({
      db: { query: vi.fn() } as unknown as Pool,
      bus: new EventBus(createSilentLogger()),
      logger: logger as Logger,
      scheduler: { lastTickAt: new Date() },
      mcpSessions: [],
      modelRoutingConfig: {
        tiers: { fast: { model: 'f' }, standard: { model: 's' }, powerful: { model: 'p' } },
        default_tier: 'standard',
      },
      config: {
        ...DEFAULT_HEALTH_CONFIG,
        heartbeats: { ...DEFAULT_HEALTH_CONFIG.heartbeats, tavily: HEARTBEAT },
      },
      resolveTavilyApiKey: async () => 'tvly-test',
    });
    await healthService.start();

    const schedule = new CanarySchedule({
      cron: DAILY_6AM,
      timezone: 'UTC',
      runCanaries: () => healthService.runCanaries(),
      logger,
    });
    schedule.start();
    await vi.advanceTimersByTimeAsync(60_000);
    schedule.stop();

    const results = [...info.mock.calls, ...error.mock.calls]
      .filter(([, msg]) => msg === 'Health canary result')
      .map(([fields]) => (fields as { canary: string }).canary);
    expect(results.sort()).toEqual([
      'embeddings', 'google_workspace', 'image_gen', 'llm_fast', 'llm_powerful',
      'llm_standard', 'nylas', 'signal', 'tavily',
    ]);
    expect(fetchMock).toHaveBeenCalledWith(HEARTBEAT);
  });
});
