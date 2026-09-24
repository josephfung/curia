// delegate-in-flight.test.ts — a timed-out specialist must not be started twice (#1858).
//
// The prod failure: the delegate wait gave up, the specialist kept running, and a later
// coordinator turn reworded the brief and delegated again. Both runs finished and both
// sent the CEO the same draft. The identical-task guard missed it because the prose
// changed and the new inbound had a fresh DelegationGuard.
//
// Real Postgres: the block is a pending_delegations row, which is what survives the turn.

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
import {
  createAgentResponse,
  createDelegationTimedOut,
  createOutboundMessage,
  type AgentTaskEvent,
} from '../../src/bus/events.js';
import {
  claimPendingDelegation,
  finalizePendingDelegation,
  findInFlightPendingDelegation,
  getPendingDelegationByDelegateEventId,
  recordPendingDelegation,
} from '../../src/db/queries/pending-delegations.js';
import type { ToolManifest, ToolResult } from '../../src/skills/types.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const logger = pino({ level: 'silent' });

const CONV_PREFIX = 'inflight-1858-';

function dataOf(result: ToolResult): Record<string, unknown> {
  if (!result.success) throw new Error(`expected success, got ${result.error}`);
  return result.data as Record<string, unknown>;
}

const delegateManifest: ToolManifest = {
  name: 'delegate',
  description: 'Delegate',
  version: '1.8.0',
  sensitivity: 'normal',
  action_risk: 'none',
  capabilities: ['bus', 'agentRegistry'],
  inputs: { agent: 'string', task: 'string' },
  outputs: { response: 'string' },
  permissions: [],
  secrets: [],
  timeout: 30_000,
};

describeIf('in-flight delegation (#1858)', () => {
  let pool: pg.Pool;
  let onTestDb = false;

  async function cleanup(): Promise<void> {
    if (!onTestDb) return;
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
    agentRegistry.register('social-media', { role: 'specialist', description: 'Social' });
    agentRegistry.register('calendar', { role: 'specialist', description: 'Calendar' });
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(delegateManifest, new DelegateHandler());
    return new ExecutionLayer(toolRegistry, logger, {
      bus,
      agentRegistry,
      openDelegationLookup: {
        findInFlight: (targetAgent, originConversationId) =>
          findInFlightPendingDelegation(pool, { targetAgent, originConversationId }),
      },
    });
  }

  it('two overlapping delegations to one specialist send the principal one message', async () => {
    const origin = `${CONV_PREFIX}overlap-${process.pid}-${Date.now()}`;
    const bus = new EventBus(logger);
    const taskRepo = new TaskRepo(pool, bus, logger, 'America/Toronto');
    const subscriber = new LateDelegationSubscriber({
      pool,
      bus,
      logger,
      taskRepo,
      ttlMinutes: 60,
      maxResultChars: 500,
      timezone: 'America/Toronto',
      knownAgents: new Set(['coordinator', 'social-media']),
    });
    subscriber.start();

    const execution = wire(bus);
    const principalMessages: string[] = [];
    bus.subscribe('outbound.message', 'system', (event) => {
      if (event.type === 'outbound.message') principalMessages.push(event.payload.content);
    });

    let releaseSpecialist = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseSpecialist = resolve;
    });
    let markSent = (): void => {};
    const sent = new Promise<void>((resolve) => {
      markSent = resolve;
    });
    let specialistTasks = 0;

    bus.subscribe('agent.task', 'agent', async (event) => {
      if (event.type !== 'agent.task' || event.payload.agentId !== 'social-media') return;
      specialistTasks += 1;
      const task = event as AgentTaskEvent;
      // The first run outlives the delegate wait, which is the abandoned specialist.
      if (specialistTasks === 1) await gate;
      await bus.publish('system', createOutboundMessage({
        conversationId: origin,
        channelId: 'signal',
        content: 'k8m5 draft',
        recipientId: '+15551212',
        parentEventId: task.id,
      }));
      await bus.publish('agent', createAgentResponse({
        agentId: 'social-media',
        conversationId: task.payload.conversationId,
        content: 'sent the draft',
        parentEventId: task.id,
      }));
      // After the response publish, so a late-delivery subscriber has finished
      // with the handle before the test deletes the row.
      markSent();
    });

    try {
      const first = await execution.invoke(
        'delegate',
        {
          agent: 'social-media',
          task: 'COORDINATOR RELAY — verified CEO approval for k8m5',
          timeout_ms: 400,
        },
        undefined,
        { conversationId: origin, agentId: 'coordinator', channelId: 'signal' },
      );
      const firstData = dataOf(first);
      expect(firstData['reason']).toBe('timeout');
      expect(firstData['possibly_succeeded']).toBe(true);
      const delegateEventId = firstData['delegate_event_id'];
      const delegateConversationId = firstData['delegate_conversation_id'];
      expect(typeof delegateEventId).toBe('string');
      expect(typeof delegateConversationId).toBe('string');

      // What the runtime does after a non-retryable timeout: publish the handle. The
      // subscriber writes the row before this publish resolves.
      await bus.publish('agent', createDelegationTimedOut({
        delegateEventId: delegateEventId as string,
        delegateConversationId: delegateConversationId as string,
        targetAgent: 'social-media',
        delegateTask: 'COORDINATOR RELAY — verified CEO approval for k8m5',
        agentId: 'coordinator',
        conversationId: origin,
        channelId: 'signal',
        senderId: '+15551212',
        originTaskEventId: 'origin-task-inflight',
        waitTimeoutMs: 400,
      }, 'origin-task-inflight'));

      const handle = await getPendingDelegationByDelegateEventId(pool, delegateEventId as string);
      expect(handle?.status).toBe('pending');
      expect(handle?.resolution).toBeNull();

      // A new inbound: empty guard, reworded brief, same agent and conversation.
      const second = await execution.invoke(
        'delegate',
        {
          agent: 'social-media',
          task: 'The principal has replied Approve k8m5 — relay the draft',
          timeout_ms: 400,
        },
        undefined,
        {
          conversationId: origin,
          agentId: 'coordinator',
          channelId: 'signal',
          delegationGuard: new DelegationGuard(),
        },
      );
      const secondData = dataOf(second);
      expect(secondData['reason']).toBe('already_in_flight');
      expect(secondData['in_flight']).toBe(true);
      expect(secondData['delegate_event_id']).toBe(delegateEventId);
      expect(typeof secondData['open_handle_age_ms']).toBe('number');
      expect(secondData['open_handle_age_ms'] as number).toBeGreaterThanOrEqual(0);
      expect(secondData['message']).toBe(
        "Specialist 'social-media' is already working on an open request in this conversation.",
      );
      expect(specialistTasks).toBe(1);
      expect(principalMessages).toEqual([]);

      releaseSpecialist();
      await Promise.race([
        sent,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('specialist did not send the principal message')), 5_000);
        }),
      ]);
      expect(principalMessages).toEqual(['k8m5 draft']);
      expect(specialistTasks).toBe(1);
    } finally {
      releaseSpecialist();
    }
  });

  it('blocks only an unresolved handle for that agent and conversation, then allows the next', async () => {
    const origin = `${CONV_PREFIX}resolved-${process.pid}-${Date.now()}`;
    const other = `${CONV_PREFIX}other-${process.pid}-${Date.now()}`;
    const bus = new EventBus(logger);
    const execution = wire(bus);
    const tasks: string[] = [];

    bus.subscribe('agent.task', 'agent', async (event) => {
      if (event.type !== 'agent.task' || event.payload.channelId !== 'internal') return;
      tasks.push(`${event.payload.agentId}:${event.payload.content}`);
      await bus.publish('agent', createAgentResponse({
        agentId: event.payload.agentId,
        conversationId: event.payload.conversationId,
        content: 'done',
        parentEventId: event.id,
      }));
    });

    const inserted = await recordPendingDelegation(pool, {
      delegateEventId: `${CONV_PREFIX}event-${process.pid}-${Date.now()}`,
      delegateConversationId: 'delegate-conv-resolved',
      targetAgent: 'social-media',
      delegateTask: 'original brief the coordinator will not repeat',
      originAgentId: 'coordinator',
      originConversationId: origin,
      originChannelId: 'signal',
      originSenderId: '+15551212',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    expect(inserted.created).toBe(true);

    const reworded = await execution.invoke(
      'delegate',
      { agent: 'social-media', task: 'completely different prose' },
      undefined,
      { conversationId: origin, agentId: 'coordinator', channelId: 'signal', delegationGuard: new DelegationGuard() },
    );
    expect(dataOf(reworded)['reason']).toBe('already_in_flight');
    expect(dataOf(reworded)['delegate_event_id']).toBe(inserted.row.delegateEventId);

    const otherAgent = await execution.invoke(
      'delegate',
      { agent: 'calendar', task: 'unrelated calendar work' },
      undefined,
      { conversationId: origin, agentId: 'coordinator', channelId: 'signal' },
    );
    expect(dataOf(otherAgent)['response']).toBe('done');

    const otherConversation = await execution.invoke(
      'delegate',
      { agent: 'social-media', task: 'other thread' },
      undefined,
      { conversationId: other, agentId: 'coordinator', channelId: 'signal' },
    );
    expect(dataOf(otherConversation)['response']).toBe('done');
    expect(tasks.some((t) => t.includes('completely different prose'))).toBe(false);

    const open = await findInFlightPendingDelegation(pool, {
      targetAgent: 'social-media',
      originConversationId: origin,
    });
    expect(open?.delegateEventId).toBe(inserted.row.delegateEventId);

    const claimed = await claimPendingDelegation(pool, {
      delegateEventId: inserted.row.delegateEventId,
      resolution: 'delivered',
      leaseSeconds: 120,
    });
    expect(claimed?.claimToken).toEqual(expect.any(String));
    await finalizePendingDelegation(pool, inserted.row.delegateEventId, claimed!.claimToken!);

    const after = await findInFlightPendingDelegation(pool, {
      targetAgent: 'social-media',
      originConversationId: origin,
    });
    expect(after).toBeNull();

    const again = await execution.invoke(
      'delegate',
      { agent: 'social-media', task: 'a later request after the handle resolved' },
      undefined,
      { conversationId: origin, agentId: 'coordinator', channelId: 'signal', delegationGuard: new DelegationGuard() },
    );
    expect(dataOf(again)['response']).toBe('done');
    expect(tasks.some((t) => t.includes('a later request after the handle resolved'))).toBe(true);
  });
});
