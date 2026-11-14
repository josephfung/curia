// tests/integration/task-wake-binding-task-end.test.ts
//
// Regression for #2592. A task-wake binding whose task had already finished stayed active,
// so later, unrelated principal replies kept matching it, and each context-bridge-release
// failed with "failed to persist task-wake reply" without releasing it. Now:
//   - a reply to a binding whose task is done releases it and succeeds (reply not attached);
//   - completing a task releases its bindings, and reopening restores only those.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { EventBus } from '../../src/bus/bus.js';
import { OutboundContextService, RELEASED_ON_TASK_END_KEY } from '../../src/dispatch/outbound-context.js';
import { TaskRepo } from '../../src/db/task-repo.js';
import { TASK_WAKE_BIND_REPLY_KEY, TASK_WAKE_TASK_ID_KEY } from '../../src/dispatch/task-wake-reply.js';
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
      data: { released: entryId, task_id: taskId, reply_attached: false, note: 'task already done; reply not attached' },
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
      const state = await entryState(id);
      expect(state.released).toBe(true);
      expect(state.metadata[RELEASED_ON_TASK_END_KEY]).toBe(true);
    }
    expect((await entryState(other)).released).toBe(false);
  });

  it('cancelling a task through updateTask releases its bindings', async () => {
    const taskId = await insertTask('waiting');
    const entryId = await bind(taskId);

    await taskRepo.updateTask(taskId, { status: 'cancelled' }, 'coordinator');

    expect((await entryState(entryId)).released).toBe(true);
  });

  it('reopening restores the bindings the task end released, not ones a reply released', async () => {
    const taskId = await insertTask('waiting');
    const endReleased = await bind(taskId);
    const replyReleased = await bind(taskId);
    await outboundContext.releaseEntry(replyReleased);

    await taskRepo.completeTask(taskId, 'Done');
    await taskRepo.reopenTask(taskId, 'Undo');

    const restored = await entryState(endReleased);
    expect(restored.released).toBe(false);
    expect(restored.metadata[RELEASED_ON_TASK_END_KEY]).toBeUndefined();
    expect((await entryState(replyReleased)).released).toBe(true);
  });
});
