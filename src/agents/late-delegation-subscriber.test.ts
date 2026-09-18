// late-delegation-subscriber.test.ts — handle creation and response matching (#1799).
//
// DB-backed behaviour lives in tests/integration/late-delegation.test.ts. Here the pool
// is a fake, so what is under test is the wiring: what gets written when a delegation times out,
// which responses are even looked at, and that a broken review-task reference costs the link
// rather than the handle.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type pg from 'pg';
import { EventBus } from '../bus/bus.js';
import type { TaskRepo } from '../db/task-repo.js';
import { createAgentResponse, createDelegationTimedOut, type AgentTaskEvent } from '../bus/events.js';
import { LateDelegationSubscriber } from './late-delegation-subscriber.js';

const logger = pino({ level: 'silent' });

interface Recorded {
  sql: string;
  params: unknown[];
}

interface FakePoolOptions {
  /** Row returned by the handle lookup, or null for "no handle for this response". */
  existingHandle?: Record<string, unknown> | null;
  /** Postgres error code the first INSERT should fail with. */
  insertFailsWith?: string;
}

function fakePool(opts: FakePoolOptions = {}): { pool: pg.Pool; queries: Recorded[] } {
  const queries: Recorded[] = [];
  let insertAttempts = 0;
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (sql.includes('INSERT INTO pending_delegations')) {
      insertAttempts += 1;
      if (insertAttempts === 1 && opts.insertFailsWith) {
        const err = new Error('insert rejected') as Error & { code?: string };
        err.code = opts.insertFailsWith;
        throw err;
      }
      return { rows: [{ delegate_event_id: params[0], status: 'pending', review_task_id: params[11] ?? null }] };
    }
    if (sql.includes('SELECT') && sql.includes('FROM pending_delegations')) {
      return { rows: opts.existingHandle ? [opts.existingHandle] : [] };
    }
    if (sql.includes('UPDATE pending_delegations')) {
      return { rows: [{ ...(opts.existingHandle ?? {}), status: 'claimed', claim_token: 'tok-1' }] };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
  });
  return { pool: { query } as unknown as pg.Pool, queries };
}

/** A duck-typed repo for tests that construct the subscriber directly. */
function startSubscriberTaskRepo(): TaskRepo {
  return {
    getTask: vi.fn(async () => null),
    updateTask: vi.fn(async () => null),
    completeTask: vi.fn(async () => null),
  } as unknown as TaskRepo;
}

function startSubscriber(pool: pg.Pool, bus: EventBus): { taskRepo: TaskRepo } {
  const taskRepo = {
    getTask: vi.fn(async () => null),
    updateTask: vi.fn(async () => null),
    completeTask: vi.fn(async () => null),
  } as unknown as TaskRepo;
  new LateDelegationSubscriber({
    pool,
    bus,
    logger,
    taskRepo,
    ttlMinutes: 60,
    maxResultChars: 500,
  }).start();
  return { taskRepo };
}

function timedOut(overrides: Record<string, unknown> = {}) {
  return createDelegationTimedOut({
    delegateEventId: 'delegate-evt-1',
    delegateConversationId: 'delegate-conv-1',
    targetAgent: 'calendar',
    delegateTask: 'Detect travel since Aug 17',
    agentId: 'coordinator',
    conversationId: 'scheduler:job-7:run-2',
    channelId: 'scheduler',
    senderId: 'scheduler',
    originTaskEventId: 'origin-evt-1',
    waitTimeoutMs: 90_000,
    ...overrides,
  }, 'origin-evt-1');
}

describe('LateDelegationSubscriber — delegation.timed_out (#1799)', () => {
  it('writes a handle carrying the origin routing and the parsed scheduler job', async () => {
    const { pool, queries } = fakePool();
    const bus = new EventBus(logger);
    startSubscriber(pool, bus);

    await bus.publish('agent', timedOut({ reviewTaskId: 'review-1' }));

    const insert = queries.find((q) => q.sql.includes('INSERT INTO pending_delegations'));
    expect(insert).toBeDefined();
    expect(insert!.params.slice(0, 9)).toEqual([
      'delegate-evt-1',
      'delegate-conv-1',
      'calendar',
      'Detect travel since Aug 17',
      'coordinator',
      'scheduler:job-7:run-2',
      'scheduler',
      'scheduler',
      'origin-evt-1',
    ]);
    // originator (null here), scheduler job id, review task id, expiry.
    expect(insert!.params[10]).toBe('job-7');
    expect(insert!.params[11]).toBe('review-1');
    expect(insert!.params[12]).toBeInstanceOf(Date);
  });

  it('extends the expiry to twice the elapsed wait when that beats the TTL', async () => {
    const { pool, queries } = fakePool();
    const bus = new EventBus(logger);
    startSubscriber(pool, bus);

    const before = Date.now();
    // A 45-minute wait doubles to 90 minutes, past the 60-minute TTL.
    await bus.publish('agent', timedOut({ waitTimeoutMs: 2_700_000 }));

    const insert = queries.find((q) => q.sql.includes('INSERT INTO pending_delegations'))!;
    const expiresAt = insert.params[12] as Date;
    expect(expiresAt.getTime() - before).toBeGreaterThan(85 * 60_000);
  });

  it('stores no scheduler job id for a non-scheduler origin', async () => {
    const { pool, queries } = fakePool();
    const bus = new EventBus(logger);
    startSubscriber(pool, bus);

    await bus.publish('agent', timedOut({ conversationId: 'signal:+15551234567', channelId: 'signal' }));

    const insert = queries.find((q) => q.sql.includes('INSERT INTO pending_delegations'))!;
    expect(insert.params[10]).toBeNull();
  });

  for (const code of ['23503', '22P02']) {
    it(`keeps the handle when the review task reference is rejected with ${code}`, async () => {
      const { pool, queries } = fakePool({ insertFailsWith: code });
      const bus = new EventBus(logger);
      startSubscriber(pool, bus);

      await bus.publish('agent', timedOut({ reviewTaskId: 'not-a-real-task' }));

      const inserts = queries.filter((q) => q.sql.includes('INSERT INTO pending_delegations'));
      expect(inserts).toHaveLength(2);
      // The retry drops only the link — every other column is still written.
      expect(inserts[1]!.params[11]).toBeNull();
      expect(inserts[1]!.params[0]).toBe('delegate-evt-1');
    });
  }

  it('does not retry an insert that failed for an unrelated reason', async () => {
    const { pool, queries } = fakePool({ insertFailsWith: '53300' }); // too_many_connections
    const bus = new EventBus(logger);
    startSubscriber(pool, bus);

    // The bus isolates subscriber errors, so the publish itself resolves.
    await bus.publish('agent', timedOut({ reviewTaskId: 'review-1' }));

    expect(queries.filter((q) => q.sql.includes('INSERT INTO pending_delegations'))).toHaveLength(1);
  });
});

describe('LateDelegationSubscriber — agent.response matching (#1799)', () => {
  it('ignores a response with no parent event', async () => {
    const { pool, queries } = fakePool();
    const bus = new EventBus(logger);
    startSubscriber(pool, bus);

    // createAgentResponse requires a parentEventId, so construct the degenerate case directly.
    await bus.publish('agent', {
      id: 'resp-orphan',
      timestamp: new Date(),
      type: 'agent.response',
      sourceLayer: 'agent',
      payload: { agentId: 'calendar', conversationId: 'c', content: 'hi' },
    });

    expect(queries).toHaveLength(0);
  });

  it('ignores a response whose parent is not a tracked delegation', async () => {
    const { pool, queries } = fakePool({ existingHandle: null });
    const bus = new EventBus(logger);
    startSubscriber(pool, bus);

    await bus.publish('agent', createAgentResponse({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      content: 'normal reply',
      parentEventId: 'some-other-task',
    }));

    // One lookup, then nothing — no claim, no annotation.
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain('FROM pending_delegations');
  });

  it('ignores a response for a handle that is already resolved', async () => {
    const { pool, queries } = fakePool({
      existingHandle: {
        delegate_event_id: 'delegate-evt-1',
        status: 'resolved',
        resolution: 'annotated_result',
        origin_channel_id: 'scheduler',
        review_task_id: null,
        target_agent: 'calendar',
        origin_conversation_id: 'scheduler:job-7:run-2',
        origin_agent_id: 'coordinator',
      },
    });
    const bus = new EventBus(logger);
    startSubscriber(pool, bus);

    await bus.publish('agent', createAgentResponse({
      agentId: 'calendar',
      conversationId: 'delegate-conv-1',
      content: 'second result',
      parentEventId: 'delegate-evt-1',
    }));

    expect(queries.some((q) => q.sql.includes('UPDATE pending_delegations'))).toBe(false);
  });

  it('claims an open handle when the abandoned specialist responds', async () => {
    const { pool, queries } = fakePool({
      existingHandle: {
        delegate_event_id: 'delegate-evt-1',
        status: 'pending',
        resolution: null,
        origin_channel_id: 'scheduler',
        review_task_id: null,
        target_agent: 'calendar',
        origin_conversation_id: 'scheduler:job-7:run-2',
        origin_agent_id: 'coordinator',
      },
    });
    const bus = new EventBus(logger);
    startSubscriber(pool, bus);

    const late = createAgentResponse({
      agentId: 'calendar',
      conversationId: 'delegate-conv-1',
      content: 'Travel detected: one trip.',
      parentEventId: 'delegate-evt-1',
    });
    await bus.publish('agent', late);

    const claim = queries.find((q) => q.sql.includes("SET status = 'claimed'"));
    expect(claim).toBeDefined();
    expect(claim!.params[0]).toBe('delegate-evt-1');
    expect(claim!.params[1]).toBe('delivered');
    expect(claim!.params[2]).toBe(late.id);
  });

  it('wakes the originating agent with the result and blocks re-delegation', async () => {
    const { pool } = fakePool({
      existingHandle: {
        delegate_event_id: 'delegate-evt-1',
        status: 'pending',
        resolution: null,
        origin_channel_id: 'scheduler',
        origin_agent_id: 'coordinator',
        origin_conversation_id: 'scheduler:job-7:run-2',
        origin_sender_id: 'scheduler',
        review_task_id: null,
        target_agent: 'calendar',
        delegate_task: 'Detect travel since Aug 17',
        scheduler_job_id: 'job-7',
        originator: {
          contactId: 'contact-ceo',
          systemRole: 'principal',
          channel: 'scheduler',
          initiatedAt: '2026-09-14T12:00:00.000Z',
        },
      },
    });
    const bus = new EventBus(logger);
    const wakes: AgentTaskEvent[] = [];
    bus.subscribe('agent.task', 'system', (e) => { wakes.push(e as AgentTaskEvent); });
    startSubscriber(pool, bus);

    await bus.publish('agent', createAgentResponse({
      agentId: 'calendar',
      conversationId: 'delegate-conv-1',
      content: 'Travel detected: YYZ→SFO Oct 2.',
      parentEventId: 'delegate-evt-1',
    }));

    expect(wakes).toHaveLength(1);
    const wake = wakes[0]!;
    expect(wake.payload.agentId).toBe('coordinator');
    expect(wake.payload.conversationId).toBe('scheduler:job-7:run-2');
    expect(wake.payload.content).toContain('Travel detected: YYZ→SFO Oct 2.');
    // The scheduled job is named so the woken turn can advance the cursor.
    expect(wake.payload.content).toContain('scheduler-report');
    expect(wake.payload.content).toContain('job-7');
    // Lineage restored, so the follow-up steps still clear the autonomy gate.
    expect((wake.payload.metadata?.originator as Record<string, unknown>)?.contactId).toBe('contact-ceo');
    expect(wake.payload.metadata?.wakeContext).toEqual({ derived: true });
    expect(wake.payload.liveTurn).toBeUndefined();
  });

  it('does not register reply routing for a scheduler origin', async () => {
    // Nobody is waiting on a reply to a scheduled run; the side effects are the point.
    const { pool } = fakePool({
      existingHandle: {
        delegate_event_id: 'delegate-evt-1',
        status: 'pending',
        resolution: null,
        origin_channel_id: 'scheduler',
        origin_agent_id: 'coordinator',
        origin_conversation_id: 'scheduler:job-7:run-2',
        origin_sender_id: 'scheduler',
        review_task_id: null,
        target_agent: 'calendar',
        delegate_task: 'Detect travel',
        originator: null,
      },
    });
    const bus = new EventBus(logger);
    const registerRouting = vi.fn();
    new LateDelegationSubscriber({
      pool, bus, logger, taskRepo: startSubscriberTaskRepo(), ttlMinutes: 60, maxResultChars: 500,
      registerRouting,
    }).start();

    await bus.publish('agent', createAgentResponse({
      agentId: 'calendar',
      conversationId: 'delegate-conv-1',
      content: 'result',
      parentEventId: 'delegate-evt-1',
    }));

    expect(registerRouting).not.toHaveBeenCalled();
  });

  it('registers reply routing for a user-facing origin', async () => {
    const { pool } = fakePool({
      existingHandle: {
        delegate_event_id: 'delegate-evt-1',
        status: 'pending',
        resolution: null,
        origin_channel_id: 'signal',
        origin_agent_id: 'coordinator',
        origin_conversation_id: 'signal:+15551234567',
        origin_sender_id: '+15551234567',
        review_task_id: null,
        target_agent: 'calendar',
        delegate_task: 'Detect travel',
        originator: {
          contactId: 'contact-ceo',
          systemRole: 'principal',
          channel: 'signal',
          initiatedAt: '2026-09-14T12:00:00.000Z',
        },
      },
    });
    const bus = new EventBus(logger);
    const registerRouting = vi.fn();
    const wakes: AgentTaskEvent[] = [];
    bus.subscribe('agent.task', 'system', (e) => { wakes.push(e as AgentTaskEvent); });
    new LateDelegationSubscriber({
      pool, bus, logger, taskRepo: startSubscriberTaskRepo(), ttlMinutes: 60, maxResultChars: 500,
      registerRouting,
    }).start();

    await bus.publish('agent', createAgentResponse({
      agentId: 'calendar',
      conversationId: 'delegate-conv-1',
      content: 'result',
      parentEventId: 'delegate-evt-1',
    }));

    // Registered BEFORE publish, or the woken agent's reply would find no routing and be dropped.
    expect(registerRouting).toHaveBeenCalledTimes(1);
    const [taskEventId, routing] = registerRouting.mock.calls[0]!;
    expect(taskEventId).toBe(wakes[0]!.id);
    expect(routing).toMatchObject({ channelId: 'signal', conversationId: 'signal:+15551234567' });
  });

  it('records instead of waking when the origin agent is no longer registered', async () => {
    const { pool, queries } = fakePool({
      existingHandle: {
        delegate_event_id: 'delegate-evt-1',
        status: 'pending',
        resolution: null,
        origin_channel_id: 'scheduler',
        origin_agent_id: 'retired-agent',
        origin_conversation_id: 'scheduler:job-7:run-2',
        origin_sender_id: 'scheduler',
        review_task_id: null,
        target_agent: 'calendar',
        delegate_task: 'Detect travel',
        originator: null,
      },
    });
    const bus = new EventBus(logger);
    const wakes: AgentTaskEvent[] = [];
    bus.subscribe('agent.task', 'system', (e) => { wakes.push(e as AgentTaskEvent); });
    new LateDelegationSubscriber({
      pool, bus, logger, taskRepo: startSubscriberTaskRepo(), ttlMinutes: 60, maxResultChars: 500,
      knownAgents: new Set(['coordinator', 'calendar']),
    }).start();

    await bus.publish('agent', createAgentResponse({
      agentId: 'calendar',
      conversationId: 'delegate-conv-1',
      content: 'result',
      parentEventId: 'delegate-evt-1',
    }));

    // Publishing to an agent nobody subscribes to would drop the result silently.
    expect(wakes).toHaveLength(0);
    const claim = queries.find((q) => q.sql.includes("SET status = 'claimed'"));
    expect(claim!.params[1]).toBe('annotated_unroutable');
  });
});
