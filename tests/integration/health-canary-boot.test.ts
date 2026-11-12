/**
 * Integration test: the health canaries survive the boot sequence (#2229).
 *
 * Wires the components in src/index.ts order with the real guards that silently
 * killed the old scheduled_jobs-based canary: the EventBus agent-owner check (#1898),
 * the Scheduler's ownsAgent predicate, and declarative stale-job cleanup (#640), which
 * runs after HealthService has started. Then it advances to health.canary_schedule and
 * expects every canary to report.
 *
 * No Postgres: the pool records SQL so the test can also assert that nothing writes a
 * scheduled_jobs row for a target no agent owns.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { EventBus } from '../../src/bus/bus.js';
import { Scheduler } from '../../src/scheduler/scheduler.js';
import { SchedulerService } from '../../src/scheduler/scheduler-service.js';
import { HealthService } from '../../src/health/health-service.js';
import { CanarySchedule } from '../../src/health/canary-schedule.js';
import { DEFAULT_HEALTH_CONFIG } from '../../src/config.js';
import { createSilentLogger } from '../../src/logger.js';
import type { AgentYamlConfig } from '../../src/agents/loader.js';

const ALL_CANARIES = [
  'embeddings', 'google_workspace', 'image_gen', 'llm_fast', 'llm_powerful',
  'llm_standard', 'nylas', 'signal', 'tavily',
];

function recordingPool() {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as Pool;
  return { pool, statements };
}

describe('health canaries across the boot sequence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // A minute before health.canary_schedule's default 06:00.
    vi.setSystemTime(new Date('2026-10-21T05:59:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('runs every canary at the scheduled time after a full boot wiring', async () => {
    const logger = createSilentLogger();
    const info = vi.spyOn(logger, 'info');
    const error = vi.spyOn(logger, 'error');
    const { pool, statements } = recordingPool();
    const registered = new Set(['coordinator']);
    const ownsAgent = (agentId: string) => registered.has(agentId);

    const bus = new EventBus(logger);
    const schedulerService = new SchedulerService(pool, bus, logger, 'UTC');
    const scheduler = new Scheduler({ pool, bus, logger, schedulerService, ownsAgent });

    const healthConfig = DEFAULT_HEALTH_CONFIG;
    const healthService = new HealthService({
      db: pool,
      bus,
      logger,
      scheduler,
      mcpSessions: [],
      modelRoutingConfig: {
        tiers: { fast: { model: 'f' }, standard: { model: 's' }, powerful: { model: 'p' } },
        default_tier: 'standard',
      },
      config: healthConfig,
    });
    await healthService.start();
    const canarySchedule = new CanarySchedule({
      cron: healthConfig.canarySchedule,
      timezone: 'UTC',
      runCanaries: () => healthService.runCanaries(),
      logger,
    });
    canarySchedule.start();

    // Later boot steps, in index.ts order: the agent-owner guard, then declarative
    // job loading with its stale-job cleanup.
    bus.setAgentOwner(ownsAgent);
    const agentConfigs: AgentYamlConfig[] = [{
      name: 'coordinator',
      model: { tier: 'standard' },
      system_prompt: 'You are the coordinator.',
      schedule: [{ cron: '0 8 * * *', task: 'daily-brief' }],
    }];
    await scheduler.loadDeclarativeJobs(agentConfigs);

    await vi.advanceTimersByTimeAsync(60_000);
    canarySchedule.stop();

    const reported = [...info.mock.calls, ...error.mock.calls]
      .filter(([, msg]) => msg === 'Health canary result')
      .map(([fields]) => (fields as { canary: string }).canary);
    expect(reported.sort()).toEqual(ALL_CANARIES);

    // Every scheduled_jobs write targets a registered agent.
    const jobWrites = statements.filter(s => /INSERT INTO scheduled_jobs/i.test(s.sql));
    expect(jobWrites.length).toBeGreaterThan(0);
    for (const write of jobWrites) {
      expect(write.params.filter(p => p === 'health-service')).toEqual([]);
    }
  });
});
