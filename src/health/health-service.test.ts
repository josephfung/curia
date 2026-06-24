// health-service.test.ts — unit tests for HealthService.
//
// Covers the agent.task dispatch fix (Fix 1): verifies that HealthService
// intercepts scheduler-fired health-canary events and calls runCanaries().

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../bus/bus.js';
import { HealthService } from './health-service.js';
import { createSilentLogger } from '../logger.js';
import { DEFAULT_HEALTH_CONFIG } from '../config.js';
import type { HealthServiceDeps } from './health-service.js';
import type { Pool } from 'pg';
import type { Scheduler } from '../scheduler/scheduler.js';

// ---------------------------------------------------------------------------
// Minimal mock builders
// ---------------------------------------------------------------------------

function makeLogger() {
  return createSilentLogger();
}

function makeBus() {
  return new EventBus(makeLogger());
}

/** Minimal Pool stub — HealthService only calls pool.query() in probes. */
function makePool(): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
  } as unknown as Pool;
}

/** Minimal Scheduler stub. */
function makeScheduler(): Pick<Scheduler, 'lastTickAt'> {
  return { lastTickAt: new Date() };
}

/** Minimal ModelRoutingConfig for the reverse-map builder. */
const modelRoutingConfig = {
  tiers: {
    fast: { model: 'claude-haiku-3-5' },
    standard: { model: 'claude-sonnet-4-5' },
    powerful: { model: 'claude-opus-4-5' },
  },
  default_tier: 'standard' as const,
};

function makeDeps(bus: EventBus, overrides: Partial<HealthServiceDeps> = {}): HealthServiceDeps {
  return {
    db: makePool(),
    bus,
    logger: makeLogger(),
    scheduler: makeScheduler(),
    mcpSessions: [],
    modelRoutingConfig,
    config: DEFAULT_HEALTH_CONFIG,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HealthService.start() — agent.task canary dispatch (Fix 1)', () => {
  let bus: EventBus;
  let svc: HealthService;

  beforeEach(async () => {
    bus = makeBus();
    // No schedulerService — skips the canary job registration so start() is synchronous.
    svc = new HealthService(makeDeps(bus));
    await svc.start();
  });

  it('calls runCanaries() when an agent.task event targets health-service', async () => {
    // Spy on runCanaries — we don't want live probes to fire in a unit test.
    const spy = vi.spyOn(svc, 'runCanaries').mockResolvedValue([]);

    // Publish a synthetic agent.task event targeting agentId 'health-service'.
    // The bus requires a valid BusEvent shape; we build a minimal one and cast.
    const event = {
      id: 'test-event-id',
      type: 'agent.task' as const,
      timestamp: new Date(),
      sourceLayer: 'dispatch' as const,
      payload: {
        agentId: 'health-service',
        conversationId: 'test-conv',
        channelId: 'test-chan',
        senderId: 'system',
        content: '{"type":"health-canary"}',
      },
    };

    // Cast through unknown — we're publishing from 'dispatch' which is allowed to publish agent.task.
    await bus.publish('dispatch', event as unknown as Parameters<typeof bus.publish>[1]);

    // Give the void-returned promise a microtask tick to settle.
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(spy).toHaveBeenCalledOnce();
  });

  it('does NOT call runCanaries() for agent.task events targeting other agents', async () => {
    const spy = vi.spyOn(svc, 'runCanaries').mockResolvedValue([]);

    const event = {
      id: 'test-event-id-2',
      type: 'agent.task' as const,
      timestamp: new Date(),
      sourceLayer: 'dispatch' as const,
      payload: {
        agentId: 'coordinator',   // a different agent — should be ignored
        conversationId: 'test-conv',
        channelId: 'test-chan',
        senderId: 'system',
        content: 'do something',
      },
    };

    await bus.publish('dispatch', event as unknown as Parameters<typeof bus.publish>[1]);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(spy).not.toHaveBeenCalled();
  });
});
