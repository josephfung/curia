// tests/integration/task-wake-reply-bind.test.ts
//
// Regression for #1299: task-wake questions bind CEO replies back to the originating task
// even when the reply arrives on a different conversation than the scheduler send.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { EventBus } from '../../src/bus/bus.js';
import { Dispatcher } from '../../src/dispatch/dispatcher.js';
import { OutboundContextService } from '../../src/dispatch/outbound-context.js';
import { TaskRepo } from '../../src/db/task-repo.js';
import { registerOutboundContext } from '../../src/dispatch/context-bridge-parse.js';
import { createInboundMessage } from '../../src/bus/events.js';
import type { AgentTaskEvent } from '../../src/bus/events.js';
import type { ContactResolver } from '../../src/contacts/contact-resolver.js';
import type { InboundSenderContext } from '../../src/contacts/types.js';
import { createSilentLogger } from '../../src/logger.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('task-wake reply binding (#1299)', () => {
  let pool: pg.Pool;
  let bus: EventBus;
  let dispatcher: Dispatcher;
  let outboundContext: OutboundContextService;
  let taskRepo: TaskRepo;
  let runId: string;
  let taskId: string;
  let schedulerConvId: string;
  let signalConvId: string;
  const capturedTasks: AgentTaskEvent[] = [];

  beforeAll(async () => {
    runId = randomUUID();
    taskId = randomUUID();
    schedulerConvId = `scheduler:job-${runId}:run-${runId}`;
    signalConvId = `signal:+1555${runId.replace(/-/g, '').slice(0, 7)}`;

    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1 FROM tasks LIMIT 0');
    await pool.query('SELECT 1 FROM outbound_context LIMIT 0');

    const logger = createSilentLogger();
    bus = new EventBus(logger);
    outboundContext = new OutboundContextService(pool, logger);
    taskRepo = new TaskRepo(pool, bus, logger, 'UTC');

    const principalResolver = {
      resolve: async (): Promise<InboundSenderContext> => ({
        resolved: true,
        contactId: 'principal-contact',
        displayName: 'CEO',
        role: 'ceo',
        systemRole: 'principal',
        tier: 'principal',
        kind: 'principal',
        verified: true,
        kgNodeId: null,
        knowledgeSummary: '',
        authorization: null,
        contactConfidence: 1.0,
      }),
    } as unknown as ContactResolver;

    bus.subscribe('agent.task', 'agent', (event) => {
      capturedTasks.push(event as AgentTaskEvent);
    });

    dispatcher = new Dispatcher({
      bus,
      logger,
      contactResolver: principalResolver,
      outboundContextService: outboundContext,
      taskRepo,
    });
    dispatcher.register();

    await pool.query(
      `INSERT INTO tasks (
         id, agent_id, source_agent_id, created_by, title, intent_anchor, status, owner, source,
         progress, error_budget, tags, updated_at
       ) VALUES ($1, 'coordinator', 'coordinator', 'coordinator', $2, $2, 'waiting', 'ceo', 'agent',
                 '{}'::jsonb, '{}'::jsonb, '{}', now())`,
      [taskId, `Trip milestone ${runId}`],
    );

    const scopedOutbound = {
      register: (entry: Parameters<OutboundContextService['register']>[0]) =>
        outboundContext.register({ ...entry, conversationId: schedulerConvId }),
      release: (entryId: string) => outboundContext.release(entryId),
      clearBySubjects: (subjects: string[]) => outboundContext.clearBySubjects(subjects),
      defaultExpiryHours: outboundContext.defaultExpiryHours,
      explicitExpiryHours: outboundContext.explicitExpiryHours,
    };

    await registerOutboundContext(scopedOutbound, undefined, {
      channelId: 'signal',
      content: 'Please confirm the camp session dates for Evan.',
      agentId: 'coordinator',
      log: logger,
      boundTask: { taskId },
    });
  });

  afterAll(async () => {
    try {
      await pool.query('DELETE FROM outbound_context WHERE conversation_id = $1', [schedulerConvId]);
      await pool.query('DELETE FROM tasks WHERE id = $1', [taskId]);
    } finally {
      await pool.end();
    }
  });

  it('registers outbound context with task binding metadata on task-wake send', async () => {
    const { rows } = await pool.query<{
      delegation_hint: string | null;
      expected_reply: string | null;
      metadata: Record<string, unknown> | null;
      expires_at: Date;
    }>(
      `SELECT delegation_hint, expected_reply, metadata, expires_at
       FROM outbound_context
       WHERE conversation_id = $1`,
      [schedulerConvId],
    );

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.delegation_hint).toContain('task-wake reply');
    expect(row.expected_reply).toContain('camp session dates');
    expect(row.metadata).toMatchObject({ bind_reply: true, task_id: taskId });
    expect(row.expires_at.getTime()).toBeGreaterThan(Date.now() + 6 * 60 * 60 * 1000);
  });

  it('persists CEO reply from a different conversation onto the originating task', async () => {
    capturedTasks.length = 0;

    const inbound = createInboundMessage({
      channelId: 'signal',
      conversationId: signalConvId,
      senderId: '+15551234567',
      content: 'Four full weeks — July 26 through August 22. Paperwork is done.',
    });

    await bus.publish('channel', inbound);

    const task = await taskRepo.getTask(taskId);
    expect(task).not.toBeNull();
    const notes = (task!.progress?.notes ?? []) as Array<{ note: string }>;
    expect(notes.some((n) => n.note.includes('July 26'))).toBe(true);
    expect(task!.owner).toBe('curia');
    expect(task!.status).toBe('in_progress');

    const { rows: released } = await pool.query<{ released: boolean }>(
      `SELECT released FROM outbound_context WHERE conversation_id = $1`,
      [schedulerConvId],
    );
    expect(released[0]?.released).toBe(true);

    const coordinatorTask = capturedTasks.find((e) => e.payload.agentId === 'coordinator');
    expect(coordinatorTask).toBeDefined();
    expect(coordinatorTask!.payload.content).not.toContain('ACTIVE OUTBOUND CONTEXT');
  });

  it('does not auto-bind when multiple task-wake asks are outstanding', async () => {
    const ambiguousTaskA = randomUUID();
    const ambiguousTaskB = randomUUID();
    const convA = `scheduler:ambig-${runId}-a`;
    const convB = `scheduler:ambig-${runId}-b`;
    const logger = createSilentLogger();

    for (const [id, title] of [[ambiguousTaskA, 'Ask A'], [ambiguousTaskB, 'Ask B']] as const) {
      await pool.query(
        `INSERT INTO tasks (
           id, agent_id, source_agent_id, created_by, title, intent_anchor, status, owner, source,
           progress, error_budget, tags, updated_at
         ) VALUES ($1, 'coordinator', 'coordinator', 'coordinator', $2, $2, 'waiting', 'ceo', 'agent',
                   '{}'::jsonb, '{}'::jsonb, '{}', now())`,
        [id, `${title} ${runId}`],
      );
    }

    const makeScoped = (conversationId: string) => ({
      register: (entry: Parameters<OutboundContextService['register']>[0]) =>
        outboundContext.register({ ...entry, conversationId }),
      release: (entryId: string) => outboundContext.release(entryId),
      clearBySubjects: (subjects: string[]) => outboundContext.clearBySubjects(subjects),
      defaultExpiryHours: outboundContext.defaultExpiryHours,
      explicitExpiryHours: outboundContext.explicitExpiryHours,
    });

    await registerOutboundContext(makeScoped(convA), undefined, {
      channelId: 'signal',
      content: 'Please confirm the camp session dates for Evan.',
      agentId: 'coordinator',
      log: logger,
      boundTask: { taskId: ambiguousTaskA },
    });
    await registerOutboundContext(makeScoped(convB), undefined, {
      channelId: 'signal',
      content: 'What time should we leave for the airport?',
      agentId: 'coordinator',
      log: logger,
      boundTask: { taskId: ambiguousTaskB },
    });

    capturedTasks.length = 0;

    await bus.publish('channel', createInboundMessage({
      channelId: 'signal',
      conversationId: `signal:ambig-${runId}`,
      senderId: '+15551234567',
      content: 'July 26 through August 22.',
    }));

    const taskA = await taskRepo.getTask(ambiguousTaskA);
    const taskB = await taskRepo.getTask(ambiguousTaskB);
    expect((taskA?.progress?.notes ?? [])).toHaveLength(0);
    expect((taskB?.progress?.notes ?? [])).toHaveLength(0);

    const { rows: activeBindings } = await pool.query<{ id: string }>(
      `SELECT id FROM outbound_context
       WHERE metadata->>'bind_reply' = 'true'
         AND conversation_id IN ($1, $2)
         AND released = false`,
      [convA, convB],
    );
    expect(activeBindings).toHaveLength(2);

    const coordinatorTask = capturedTasks.find((e) => e.payload.agentId === 'coordinator');
    expect(coordinatorTask).toBeDefined();
    expect(coordinatorTask!.payload.content).toContain('ACTIVE OUTBOUND CONTEXT');

    await pool.query(
      `DELETE FROM outbound_context WHERE conversation_id IN ($1, $2)`,
      [convA, convB],
    );
    await pool.query('DELETE FROM tasks WHERE id IN ($1, $2)', [ambiguousTaskA, ambiguousTaskB]);
  });
});
