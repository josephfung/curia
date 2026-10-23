// tests/integration/outbound-context-wake-scope.test.ts
//
// #2261: a task wake an outside contact started can message that contact, so it must carry
// only what was sent to them and what they wrote, never another contact's reply. Runs the
// real Scheduler.pollDueJobs against Postgres: only the job-select and claim statements are
// answered with a fixed task-wake row, and every other statement, including the
// outbound_context read, goes to the database. Adapted from the PR review's repro (S5, B3).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { EventBus } from '../../src/bus/bus.js';
import { Scheduler } from '../../src/scheduler/scheduler.js';
import { OutboundContextService } from '../../src/dispatch/outbound-context.js';
import { createSilentLogger } from '../../src/logger.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const WAKING_TASK = 'task-wake-scope-1';

/** Fire one task wake for `agentId` with the given originator; returns the wake body. */
async function fireTaskWake(
  pool: pg.Pool,
  agentId: string,
  originator: Record<string, unknown> | null,
): Promise<Record<string, unknown>> {
  const logger = createSilentLogger();
  const bus = new EventBus(logger);
  const bodies: string[] = [];
  bus.subscribe('agent.task', 'system', (event) => {
    bodies.push((event as { payload: { content: string } }).payload.content);
  });

  const row = {
    id: randomUUID(), agent_id: agentId, cron_expr: null, run_at: new Date().toISOString(),
    task_payload: { type: 'task-wake' }, status: 'pending', last_run_at: null,
    next_run_at: new Date().toISOString(), last_error: null, consecutive_failures: 0,
    created_by: 'task-create', created_at: new Date().toISOString(), timezone: 'UTC',
    agent_task_id: WAKING_TASK, intent_anchor: 'Find a lunch date', progress: {},
    task_title: 'Lunch date', run_started_at: null, expected_duration_seconds: null,
    last_run_outcome: null, last_run_summary: null, last_run_context: null, originator,
  };
  const wrapped = {
    query: async (sql: string, params?: unknown[]) => {
      const flat = sql.replace(/\s+/g, ' ');
      if (flat.includes('FROM scheduled_jobs sj')) return { rows: [row], rowCount: 1 };
      if (flat.includes('SET status = $1, run_started_at = now()')) {
        return { rowCount: 1, rows: [{ run_started_at: '2026-10-23 12:00:00.123456+00' }] };
      }
      return pool.query(sql, params);
    },
  };
  const scheduler = new Scheduler({
    pool: wrapped as unknown as pg.Pool,
    bus,
    logger,
    schedulerService: {
      completeJobRun: async () => ({ suspended: false }), nextRunFromCron: () => new Date(),
      getJob: async () => null, recoverStuckJob: async () => undefined, pauseJobForDrift: async () => undefined,
    } as never,
    outboundContextService: new OutboundContextService(pool, logger),
    ownsAgent: () => true,
  });
  scheduler.start();
  await scheduler.pollDueJobs();
  await scheduler.drainInFlight(); // publish is detached from the poll
  scheduler.stop();
  if (bodies.length === 0) throw new Error('scheduler published no agent.task event');
  return JSON.parse(bodies[0]!) as Record<string, unknown>;
}

describeIf('task wakes see only what their originator may see (#2261)', () => {
  let pool: pg.Pool;
  let service: OutboundContextService;
  let dbVerified = false;
  const conversationId = `test-wake-scope-${randomUUID()}`;
  const contactA = randomUUID();
  const contactB = randomUUID();
  const outsider = (contactId: string) => ({
    contactId, systemRole: null, channel: 'email', initiatedAt: new Date().toISOString(), tier: 'known',
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    dbVerified = true;
    service = new OutboundContextService(pool, createSilentLogger());
  });

  afterAll(async () => {
    if (dbVerified) {
      await pool.query('DELETE FROM outbound_context WHERE conversation_id = $1', [conversationId]);
    }
    await pool.end();
  });

  async function register(agentId: string, content: string, to: string[]): Promise<string> {
    return service.register({
      conversationId, channelId: 'signal', agentId, content, expectedReply: 'a date', expiresInHours: 1,
      recipientContactIds: to,
    });
  }

  it('a wake contact B started omits contact A\'s reply, including on an entry sent to both', async () => {
    const agentId = `coordinator-${randomUUID()}`;
    const toA = await register(agentId, 'A: does Thu Nov 5 work?', [contactA]);
    await service.recordReply([toA], { from: 'Contact A', contactId: contactA, content: 'A-PRIVATE-ANSWER Thur Nov 5' });
    const toBoth = await register(agentId, 'Both: lunch at Wildcraft?', [contactA, contactB]);
    await service.recordReply([toBoth], { from: 'Contact A', contactId: contactA, content: 'A-SHARED-ENTRY-ANSWER' });
    await service.recordReply([toBoth], { from: 'Contact B', contactId: contactB, content: 'B works for me' });

    const body = JSON.stringify(await fireTaskWake(pool, agentId, outsider(contactB)));
    expect(body).not.toContain('A-PRIVATE-ANSWER');
    expect(body).not.toContain('A-SHARED-ENTRY-ANSWER');
    expect(body).toContain('B works for me');
  });

  it('a wake an unresolved outsider started lists no messages at all', async () => {
    const agentId = `coordinator-${randomUUID()}`;
    const toA = await register(agentId, 'A: does Thu Nov 5 work?', [contactA]);
    await service.recordReply([toA], { from: 'Contact A', contactId: contactA, content: 'A-PRIVATE-ANSWER' });

    const body = await fireTaskWake(pool, agentId, outsider('unresolved'));
    expect(body).not.toHaveProperty('messages_back_on_open_sends');
  });

  it('a system wake still sees every reply on its agent\'s sends', async () => {
    const agentId = `coordinator-${randomUUID()}`;
    const toA = await register(agentId, 'A: does Thu Nov 5 work?', [contactA]);
    await service.recordReply([toA], { from: 'Contact A', contactId: contactA, content: 'Thur Nov 5' });
    for (let i = 0; i < 6; i++) {
      const other = await register(agentId, `Other ask ${i}`, [randomUUID()]);
      await service.recordReply([other], { from: `Other ${i}`, contactId: randomUUID(), content: `reply ${i}` });
    }

    const body = await fireTaskWake(pool, agentId, null);
    const listed = (body['messages_back_on_open_sends'] as Array<{ entry_id: string }> | undefined) ?? [];
    // Six newer replies: the older unbound send is still inside the window.
    expect(listed.map((r) => r.entry_id)).toContain(toA);
  });
});
