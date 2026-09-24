// delegate-running-claim.test.ts — one specialist run while the wait is still open (#1893).
//
// The post-timeout guard cannot see a delegation that has not expired yet. The claim
// is a running row written at dispatch. A second brief is queued, then runs once the
// claim is released.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { EventBus } from '../../src/bus/bus.js';
import { AgentRegistry } from '../../src/agents/agent-registry.js';
import { DelegationGuard } from '../../src/agents/delegation-guard.js';
import { ToolRegistry } from '../../src/skills/registry.js';
import { ExecutionLayer } from '../../src/skills/execution.js';
import { DelegateHandler } from '../../skills/delegate/handler.js';
import { TaskRepo } from '../../src/db/task-repo.js';
import { LateDelegationSubscriber } from '../../src/agents/late-delegation-subscriber.js';
import { LateDelegationSweep } from '../../src/agents/late-delegation-sweep.js';
import {
  createAgentResponse,
  createDelegationTimedOut,
  createOutboundMessage,
  type AgentTaskEvent,
} from '../../src/bus/events.js';
import {
  acquireRunningDelegation,
  findInFlightPendingDelegation,
  getPendingDelegationByDelegateEventId,
  releaseRunningDelegation,
} from '../../src/db/queries/pending-delegations.js';
import { enqueueUndispatchedDelegation } from '../../src/agents/deferred-delegation.js';
import type { ToolManifest, ToolResult } from '../../src/skills/types.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const logger = pino({ level: 'silent' });

const CONV_PREFIX = 'running-1893-';

function dataOf(result: ToolResult): Record<string, unknown> {
  if (!result.success) throw new Error(`expected success, got ${result.error}`);
  return result.data as Record<string, unknown>;
}

const delegateManifest: ToolManifest = {
  name: 'delegate',
  description: 'Delegate',
  version: '1.8.1',
  sensitivity: 'normal',
  action_risk: 'none',
  capabilities: ['bus', 'agentRegistry'],
  inputs: { agent: 'string', task: 'string' },
  outputs: { response: 'string' },
  permissions: [],
  secrets: [],
  timeout: 30_000,
};

describeIf('dispatch-time delegation claim (#1893)', () => {
  let pool: pg.Pool;
  let onTestDb = false;

  async function cleanup(): Promise<void> {
    if (!onTestDb) return;
    await pool.query(
      `DELETE FROM scheduled_jobs
        WHERE task_payload #>> '{delegationRetry,conversationId}' LIKE $1`,
      [`${CONV_PREFIX}%`],
    );
    await pool.query(
      `DELETE FROM tasks
        WHERE 'delegation-retry' = ANY(tags)
          AND description LIKE $1`,
      [`%${CONV_PREFIX}%`],
    );
    await pool.query(
      `DELETE FROM pending_delegations WHERE origin_conversation_id LIKE $1`,
      [`${CONV_PREFIX}%`],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    onTestDb = true;
  });

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    if (pool) await pool.end();
  });

  function wire(bus: EventBus): ExecutionLayer {
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('coordinator', { role: 'coordinator', description: 'Main' });
    agentRegistry.register('calendar', { role: 'specialist', description: 'Calendar' });
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(delegateManifest, new DelegateHandler());
    return new ExecutionLayer(toolRegistry, logger, {
      bus,
      agentRegistry,
      openDelegationLookup: {
        findInFlight: (targetAgent, originConversationId) =>
          findInFlightPendingDelegation(pool, { targetAgent, originConversationId }),
        acquireRunning: (params) => acquireRunningDelegation(pool, params),
        releaseRunning: (delegateEventId) => releaseRunningDelegation(pool, delegateEventId),
      },
    });
  }

  function invokeOpts(origin: string) {
    return {
      conversationId: origin,
      agentId: 'coordinator',
      channelId: 'signal',
      senderId: '+15551212',
      delegationGuard: new DelegationGuard(),
    };
  }

  it('two overlapping delegations start one specialist and send the principal one message', async () => {
    const origin = `${CONV_PREFIX}overlap-${process.pid}-${Date.now()}`;
    const bus = new EventBus(logger);
    const execution = wire(bus);
    const principalMessages: string[] = [];
    bus.subscribe('outbound.message', 'system', (event) => {
      if (event.type === 'outbound.message') principalMessages.push(event.payload.content);
    });

    let releaseSpecialist = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseSpecialist = resolve;
    });
    let specialistTasks = 0;
    bus.subscribe('agent.task', 'agent', async (event) => {
      if (event.type !== 'agent.task' || event.payload.agentId !== 'calendar') return;
      specialistTasks += 1;
      const task = event as AgentTaskEvent;
      if (specialistTasks === 1) await gate;
      await bus.publish('system', createOutboundMessage({
        conversationId: origin,
        channelId: 'signal',
        content: 'booked Monday',
        recipientId: '+15551212',
        parentEventId: task.id,
      }));
      await bus.publish('agent', createAgentResponse({
        agentId: 'calendar',
        conversationId: task.payload.conversationId,
        content: 'booked Monday',
        parentEventId: task.id,
      }));
    });

    const firstPromise = execution.invoke(
      'delegate',
      { agent: 'calendar', task: `Reserve the first room ${origin}`, timeout_ms: 5_000 },
      undefined,
      invokeOpts(origin),
    );

    const started = Date.now();
    while (specialistTasks < 1 && Date.now() - started < 5_000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(specialistTasks).toBe(1);

    try {
      const second = await execution.invoke(
        'delegate',
        { agent: 'calendar', task: `Reserve the second room ${origin}`, timeout_ms: 5_000 },
        undefined,
        invokeOpts(origin),
      );
      const secondData = dataOf(second);
      expect(secondData['reason']).toBe('already_in_flight');
      expect(secondData['in_flight']).toBe(true);
      expect(specialistTasks).toBe(1);
      expect(principalMessages).toEqual([]);

      const open = await findInFlightPendingDelegation(pool, {
        targetAgent: 'calendar',
        originConversationId: origin,
      });
      expect(open).not.toBeNull();

      releaseSpecialist();
      const first = await firstPromise;
      expect(dataOf(first)['response']).toBe('booked Monday');
      expect(principalMessages).toEqual(['booked Monday']);
      expect(specialistTasks).toBe(1);

      const after = await findInFlightPendingDelegation(pool, {
        targetAgent: 'calendar',
        originConversationId: origin,
      });
      expect(after).toBeNull();
    } finally {
      releaseSpecialist();
    }
  });

  it('queues the second brief and runs it once the first claim is released', async () => {
    const origin = `${CONV_PREFIX}series-${process.pid}-${Date.now()}`;
    const briefB = `Reserve the second room ${origin}`;
    const bus = new EventBus(logger);
    const execution = wire(bus);
    const taskRepo = new TaskRepo(pool, bus, logger, 'America/Toronto');

    let releaseSpecialist = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseSpecialist = resolve;
    });
    const specialistBriefs: string[] = [];
    bus.subscribe('agent.task', 'agent', async (event) => {
      if (event.type !== 'agent.task' || event.payload.agentId !== 'calendar') return;
      const task = event as AgentTaskEvent;
      // The coordinator's brief is on the delegation metadata, not the specialist
      // conversation. Count the task content the specialist actually received.
      specialistBriefs.push(task.payload.content);
      if (specialistBriefs.length === 1) await gate;
      await bus.publish('agent', createAgentResponse({
        agentId: 'calendar',
        conversationId: task.payload.conversationId,
        content: 'booked',
        parentEventId: task.id,
      }));
    });

    const firstPromise = execution.invoke(
      'delegate',
      { agent: 'calendar', task: `Reserve the first room ${origin}`, timeout_ms: 5_000 },
      undefined,
      invokeOpts(origin),
    );
    const started = Date.now();
    while (specialistBriefs.length < 1 && Date.now() - started < 5_000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    try {
      const second = await execution.invoke(
        'delegate',
        { agent: 'calendar', task: briefB, timeout_ms: 5_000 },
        undefined,
        invokeOpts(origin),
      );
      expect(dataOf(second)['reason']).toBe('already_in_flight');

      const queued = await enqueueUndispatchedDelegation({
        taskRepo,
        logger,
        originAgentId: 'coordinator',
        originConversationId: origin,
        originChannelId: 'signal',
        originSenderId: '+15551212',
        targetAgent: 'calendar',
        brief: briefB,
        wakeAt: new Date(Date.now() + 60_000),
        attempt: 1,
        originator: {
          contactId: 'contact-1',
          systemRole: 'principal',
          channel: 'signal',
          initiatedAt: '2026-09-24T00:00:00.000Z',
          tier: 'principal',
        },
      });
      expect(queued).toBe('enqueued');

      const jobs = await pool.query<{ task_payload: { delegationRetry?: { conversationId?: string; brief?: string } }; run_at: Date }>(
        `SELECT task_payload, run_at FROM scheduled_jobs
          WHERE task_payload #>> '{delegationRetry,conversationId}' = $1`,
        [origin],
      );
      expect(jobs.rows).toHaveLength(1);
      expect(jobs.rows[0]!.task_payload.delegationRetry?.conversationId).toBe(origin);
      expect(jobs.rows[0]!.task_payload.delegationRetry?.brief).toBe(briefB);
      expect(jobs.rows[0]!.run_at.getTime()).toBeGreaterThan(Date.now());

      const tasks = await pool.query<{ description: string; originator: { contactId?: string } | null }>(
        `SELECT description, originator FROM tasks
          WHERE description = $1 AND 'delegation-retry' = ANY(tags)`,
        [briefB],
      );
      expect(tasks.rows).toHaveLength(1);
      expect(tasks.rows[0]!.originator?.contactId).toBe('contact-1');

      releaseSpecialist();
      await firstPromise;
      expect(specialistBriefs).toHaveLength(1);

      const third = await execution.invoke(
        'delegate',
        { agent: 'calendar', task: briefB, timeout_ms: 5_000 },
        undefined,
        invokeOpts(origin),
      );
      expect(dataOf(third)['response']).toBe('booked');
      expect(specialistBriefs.filter((brief) => brief === briefB)).toHaveLength(1);
    } finally {
      releaseSpecialist();
    }
  });

  it('promotes a timed-out claim into one pending handle', async () => {
    const origin = `${CONV_PREFIX}promote-${process.pid}-${Date.now()}`;
    const bus = new EventBus(logger);
    const taskRepo = new TaskRepo(pool, bus, logger, 'America/Toronto');
    const subscriber = new LateDelegationSubscriber({
      pool,
      bus,
      logger,
      taskRepo,
      ttlMinutes: 60,
      maxResultChars: 200,
    });
    subscriber.start();
    const execution = wire(bus);

    let releaseSpecialist = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseSpecialist = resolve;
    });
    bus.subscribe('agent.task', 'agent', async (event) => {
      if (event.type !== 'agent.task' || event.payload.agentId !== 'calendar') return;
      await gate;
      await bus.publish('agent', createAgentResponse({
        agentId: 'calendar',
        conversationId: event.payload.conversationId,
        content: 'late',
        parentEventId: event.id,
      }));
    });

    try {
      const result = await execution.invoke(
        'delegate',
        { agent: 'calendar', task: `Reserve the first room ${origin}`, timeout_ms: 200 },
        undefined,
        invokeOpts(origin),
      );
      const data = dataOf(result);
      expect(data['reason']).toBe('timeout');
      const delegateEventId = data['delegate_event_id'] as string;

      const running = await getPendingDelegationByDelegateEventId(pool, delegateEventId);
      expect(running?.status).toBe('running');

      await bus.publish('agent', createDelegationTimedOut({
        delegateEventId,
        delegateConversationId: data['delegate_conversation_id'] as string,
        targetAgent: 'calendar',
        delegateTask: `Reserve the first room ${origin}`,
        agentId: 'coordinator',
        conversationId: origin,
        channelId: 'signal',
        senderId: '+15551212',
        originTaskEventId: 'origin-task',
        waitTimeoutMs: 200,
      }, 'origin-task'));

      const pending = await getPendingDelegationByDelegateEventId(pool, delegateEventId);
      expect(pending?.status).toBe('pending');
      expect(pending?.id).toBe(running?.id);
      const count = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pending_delegations WHERE origin_conversation_id = $1`,
        [origin],
      );
      expect(count.rows[0]!.n).toBe('1');
    } finally {
      releaseSpecialist();
    }
  });

  it('the sweep abandons a running claim whose wait has already expired', async () => {
    const origin = `${CONV_PREFIX}sweep-${process.pid}-${Date.now()}`;
    const bus = new EventBus(logger);
    const taskRepo = new TaskRepo(pool, bus, logger, 'America/Toronto');
    const acquired = await acquireRunningDelegation(pool, {
      delegateEventId: `${CONV_PREFIX}event-${process.pid}-${Date.now()}`,
      delegateConversationId: 'delegate-conv',
      targetAgent: 'calendar',
      delegateTask: 'orphaned',
      originAgentId: 'coordinator',
      originConversationId: origin,
      originChannelId: 'signal',
      originSenderId: '+15551212',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(acquired.acquired).toBe(true);
    if (!acquired.acquired) return;

    const sweep = new LateDelegationSweep({
      pool,
      bus,
      logger,
      taskRepo,
      intervalMinutes: 60,
      ttlMinutes: 60,
      maxResultChars: 200,
    });
    const live = await sweep.tick();
    expect(live.abandoned).toBe(0);
    const stillRunning = await getPendingDelegationByDelegateEventId(pool, acquired.claim.delegateEventId);
    expect(stillRunning?.status).toBe('running');

    await pool.query(
      `UPDATE pending_delegations SET expires_at = now() - interval '1 second' WHERE delegate_event_id = $1`,
      [acquired.claim.delegateEventId],
    );
    const expired = await sweep.tick();
    expect(expired.abandoned).toBe(1);
    const after = await getPendingDelegationByDelegateEventId(pool, acquired.claim.delegateEventId);
    expect(after?.status).toBe('resolved');
    expect(after?.resolution).toBe('abandoned_ttl');
  });
});
