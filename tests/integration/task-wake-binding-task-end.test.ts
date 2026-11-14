// tests/integration/task-wake-binding-task-end.test.ts
//
// Regression for #2592. A task-wake binding whose task had already finished stayed active,
// so later, unrelated principal replies kept matching it, and each context-bridge-release
// failed with "failed to persist task-wake reply" without releasing it. Now:
//   - a reply to a binding whose task is done releases it and succeeds (reply not attached);
//   - completing or cancelling a task releases its bindings, and no other task's;
//   - a send after the task ended (or for a task that does not exist) registers no binding.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { EventBus } from '../../src/bus/bus.js';
import { OutboundContextService, ScopedOutboundContext } from '../../src/dispatch/outbound-context.js';
import { registerOutboundContext } from '../../src/dispatch/context-bridge-parse.js';
import { TaskRepo } from '../../src/db/task-repo.js';
import { TASK_WAKE_BIND_REPLY_KEY, TASK_WAKE_TASK_ID_KEY, recordTaskWakeReply } from '../../src/dispatch/task-wake-reply.js';
import { createSilentLogger } from '../../src/logger.js';
import { ContextBridgeReleaseHandler } from '../../skills/context-bridge/tools/context-bridge-release/handler.js';
import { AgentRegistry } from '../../src/agents/agent-registry.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('task-wake bindings of finished tasks (#2592)', () => {
  let pool: pg.Pool;
  let outboundContext: OutboundContextService;
  /** Wired as production wires it: task ends release bindings. */
  let taskRepo: TaskRepo;
  /** No binding hook: how a task finished before this fix, leaving its binding active. */
  let legacyTaskRepo: TaskRepo;
  let convId: string;
  let onTestDb = false;
  const taskIds: string[] = [];

  async function insertTask(status: string): Promise<string> {
    const id = randomUUID();
    taskIds.push(id);
    await pool.query(
      `INSERT INTO tasks (
         id, agent_id, source_agent_id, created_by, title, intent_anchor, status, owner, source,
         progress, error_budget, tags, updated_at
       ) VALUES ($1, 'coordinator', 'coordinator', 'coordinator', $2, $2, $3, 'curia', 'agent',
                 '{}'::jsonb, '{}'::jsonb, '{}', now())`,
      [id, `Follow up on meeting minutes ${id}`, status],
    );
    return id;
  }

  async function bind(taskId: string): Promise<string> {
    return outboundContext.register({
      conversationId: convId,
      channelId: 'signal',
      agentId: 'coordinator',
      content: 'Did the minutes go out?',
      metadata: { [TASK_WAKE_BIND_REPLY_KEY]: true, [TASK_WAKE_TASK_ID_KEY]: taskId },
      expiresInHours: 168,
    });
  }

  async function entryState(entryId: string): Promise<{ released: boolean; metadata: Record<string, unknown> }> {
    const { rows } = await pool.query<{ released: boolean; metadata: Record<string, unknown> }>(
      `SELECT released, metadata FROM outbound_context WHERE id = $1`,
      [entryId],
    );
    return rows[0]!;
  }

  beforeAll(async () => {
    convId = `scheduler:job-${randomUUID()}:run`;
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    onTestDb = true;
    await pool.query('SELECT 1 FROM tasks LIMIT 0');
    await pool.query('SELECT 1 FROM outbound_context LIMIT 0');

    const logger = createSilentLogger();
    const bus = new EventBus(logger);
    outboundContext = new OutboundContextService(pool, logger);
    taskRepo = new TaskRepo(pool, bus, logger, 'UTC', undefined, undefined, outboundContext);
    legacyTaskRepo = new TaskRepo(pool, bus, logger, 'UTC');
  });

  afterAll(async () => {
    // vitest runs afterAll even when beforeAll threw, so only clean up once the guard passed.
    if (!onTestDb) {
      await pool?.end();
      return;
    }
    try {
      await pool.query('DELETE FROM outbound_context WHERE conversation_id = $1', [convId]);
      await pool.query('DELETE FROM scheduled_jobs WHERE task_id = ANY($1::uuid[])', [taskIds]);
      await pool.query('DELETE FROM tasks WHERE id = ANY($1::uuid[])', [taskIds]);
    } finally {
      await pool.end();
    }
  });

  it('a reply to a binding whose task is already done releases it and succeeds', async () => {
    const taskId = await insertTask('in_progress');
    const entryId = await bind(taskId);
    await legacyTaskRepo.completeTask(taskId, 'Minutes sent');
    expect((await entryState(entryId)).released).toBe(false);

    const result = await new ContextBridgeReleaseHandler().execute({
      input: { entry_id: entryId, reply: 'Thursday the 12 is better' },
      secret: () => 'unused',
      log: createSilentLogger(),
      agentId: 'coordinator',
      agentRegistry: new AgentRegistry(),
      taskRepo,
      outboundContext,
    } as never);

    expect(result).toEqual({
      success: true,
      data: {
        released: entryId,
        task_id: taskId,
        reply_attached: false,
        note: expect.stringMatching(/^task already done; reply not attached\./),
      },
    });
    expect((await entryState(entryId)).released).toBe(true);
    const task = await taskRepo.getTask(taskId);
    const notes = (task!.progress?.notes ?? []) as Array<{ note: string }>;
    expect(notes.some((n) => n.note.includes('Thursday'))).toBe(false);
  });

  it('completing a task releases its bindings and no other task\'s', async () => {
    const taskId = await insertTask('in_progress');
    const otherTaskId = await insertTask('waiting');
    const a = await bind(taskId);
    const b = await bind(taskId);
    const other = await bind(otherTaskId);

    await taskRepo.completeTask(taskId, 'Done');

    for (const id of [a, b]) {
      expect((await entryState(id)).released).toBe(true);
    }
    expect((await entryState(other)).released).toBe(false);
  });

  it('cancelling a task through updateTask releases its bindings', async () => {
    const taskId = await insertTask('waiting');
    const entryId = await bind(taskId);

    await taskRepo.updateTask(taskId, { status: 'cancelled' }, 'coordinator');

    expect((await entryState(entryId)).released).toBe(true);
  });

  // A task can fail (failResumableTask) after the reply read it as waiting. The reply's write
  // must not move it back to in_progress: only the UPDATE's own guard can catch that, so both
  // reads here see the stale `waiting` row while the database says `failed`.
  it('a reply racing a task failure leaves the task failed and the reply unattached', async () => {
    const taskId = await insertTask('waiting');
    const entryId = await bind(taskId);
    const stale = (await taskRepo.getTask(taskId))!;
    await pool.query(`UPDATE tasks SET status = 'failed' WHERE id = $1`, [taskId]);
    const getTask = vi.spyOn(taskRepo, 'getTask').mockResolvedValue(stale);
    let result: Awaited<ReturnType<typeof recordTaskWakeReply>>;
    try {
      result = await recordTaskWakeReply({
        reply: 'Go ahead with Thursday',
        entryId,
        entry: (await outboundContext.getEntry(entryId))!,
        taskRepo,
        outboundContext,
        logger: createSilentLogger(),
      });
    } finally {
      getTask.mockRestore();
    }

    expect(result).toMatchObject({ persisted: false, released: true, taskId });
    expect(result.note).toMatch(/^task already failed; reply not attached\./);
    const after = (await taskRepo.getTask(taskId))!;
    expect(after.status).toBe('failed');
    const notes = (after.progress?.notes ?? []) as Array<{ note: string }>;
    expect(notes.some((n) => n.note.includes('Thursday'))).toBe(false);
    expect((await entryState(entryId)).released).toBe(true);
  });

  // The task-end release covers bindings that exist when the task ends. A turn can complete its
  // task and then send (to report it): that send must not register a fresh binding.
  describe('a send after the task ended registers no binding', () => {
    async function activeBindingsFor(taskId: string): Promise<number> {
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM outbound_context
          WHERE conversation_id = $1 AND released = false AND expires_at > now()
            AND metadata ->> $2::text = 'true' AND metadata ->> $3::text = $4`,
        [convId, TASK_WAKE_BIND_REPLY_KEY, TASK_WAKE_TASK_ID_KEY, taskId],
      );
      return Number(rows[0]!.n);
    }
    const send = (taskId: string, bridge?: unknown) =>
      registerOutboundContext(new ScopedOutboundContext(outboundContext, convId), bridge, {
        channelId: 'signal',
        content: 'Done: the minutes went out.',
        agentId: 'coordinator',
        log: createSilentLogger(),
        boundTask: { taskId },
      });

    it('complete, then a task-wake send: no binding', async () => {
      const taskId = await insertTask('in_progress');
      await taskRepo.completeTask(taskId, 'Minutes sent');
      await send(taskId);
      expect(await activeBindingsFor(taskId)).toBe(0);
    });

    it('cancel, then a send with an explicit binding in its bridge: the binding is stripped', async () => {
      const taskId = await insertTask('waiting');
      await taskRepo.updateTask(taskId, { status: 'cancelled' }, 'coordinator');
      await send(taskId, JSON.stringify({
        agent_id: 'coordinator',
        metadata: { [TASK_WAKE_BIND_REPLY_KEY]: true, [TASK_WAKE_TASK_ID_KEY]: taskId },
      }));
      expect(await activeBindingsFor(taskId)).toBe(0);
    });

    it('a task that does not exist gets no binding', async () => {
      const taskId = randomUUID();
      await send(taskId);
      expect(await activeBindingsFor(taskId)).toBe(0);
    });

    it('a live task still binds', async () => {
      const taskId = await insertTask('in_progress');
      await send(taskId);
      expect(await activeBindingsFor(taskId)).toBe(1);
    });
  });
});
