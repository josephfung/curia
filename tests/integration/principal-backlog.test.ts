// principal-backlog.test.ts — the backlog counts against real Postgres (prompt trim PR 7).
//
// The backlog line tells the coordinator how many items each list tool will show, so each
// count must match its tool's read: decay-warnings-list (KnowledgeGraphStore.listDecayWarnings),
// list-pending-actions (ActionLogRepo.findAllPending) and task-list with owner `ceo` and the
// open statuses (TaskRepo.listTasks). The shared database may hold other rows, so the test
// compares the counts with the reads, and checks that one row of each kind moves its count
// by one while the near misses beside it move nothing.

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { OPEN_TASK_STATUSES } from '../../src/agents/prompts/backlog-line.js';
import { ActionLogRepo } from '../../src/autonomy/action-log-repo.js';
import type { EventBus } from '../../src/bus/bus.js';
import { TaskRepo } from '../../src/db/task-repo.js';
import { createPrincipalBacklogSource } from '../../src/dispatch/principal-backlog.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const logger = pino({ level: 'silent' });
const noopBus = { publish: async () => {}, subscribe: () => {} } as unknown as EventBus;
const PREFIX = `PrincipalBacklog Test ${randomUUID()}`;

describeIf('principal backlog counts (prompt trim PR 7)', () => {
  let pool: pg.Pool;
  let tasks: TaskRepo;
  let actions: ActionLogRepo;
  let kg: KnowledgeGraphStore;
  const nodeIds: string[] = [];
  const taskId = `principal-backlog-test-${randomUUID()}`;
  // The suite writes a pending email-send approval and principal-owned tasks, which a real
  // instance would surface or act on, so it runs only against curia_test.
  let dbVerified = false;

  async function insertWarnedNode(opts: { archived?: boolean; identitySource?: 'label' | 'contact'; warned?: boolean }): Promise<void> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO kg_nodes (type, label, properties, source, confidence, decay_class, sensitivity, identity_source,
                             created_at, last_confirmed_at, warned_at, warn_reason, archived_at)
       VALUES ('fact', $1, '{}', 'test', 0.2, 'slow_decay', 'internal', $2, now(), now(),
               CASE WHEN $3 THEN now() END, CASE WHEN $3 THEN 'high_sensitivity' END,
               CASE WHEN $4 THEN now() END)
       RETURNING id`,
      [`${PREFIX} ${randomUUID()}`, opts.identitySource ?? 'label', opts.warned ?? true, opts.archived ?? false],
    );
    nodeIds.push(rows[0]!.id);
  }

  async function insertApproval(expiresInMs: number, outcome: 'pending_approval' | 'approved' = 'pending_approval'): Promise<void> {
    await actions.insert({
      taskId,
      toolName: 'email-send',
      actionRisk: 'medium',
      outcome,
      expiresAt: new Date(Date.now() + expiresInMs),
      description: PREFIX,
    });
  }

  async function insertTask(owner: 'ceo' | 'curia', status: string): Promise<void> {
    const task = await tasks.createTask({ agentId: 'coordinator', title: `${PREFIX} ${owner} ${status}`, owner, source: 'coordinator' });
    if (status !== 'open') {
      await pool.query(`UPDATE tasks SET status = $1 WHERE id = $2`, [status, task.id]);
    }
  }

  async function reads() {
    return {
      decayWarnings: (await kg.listDecayWarnings()).length,
      pendingApprovals: (await actions.findAllPending()).length,
      principalTasks: (await tasks.listTasks({ owner: 'ceo', statuses: [...OPEN_TASK_STATUSES], limit: 100_000 })).length,
    };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    dbVerified = true;
    tasks = new TaskRepo(pool, noopBus, logger as never, 'UTC');
    actions = new ActionLogRepo(pool, logger as never);
    kg = KnowledgeGraphStore.createWithPostgres(pool, EmbeddingService.createForTesting(), logger as never);
  });

  afterAll(async () => {
    if (dbVerified) {
      await pool.query(`DELETE FROM tasks WHERE title LIKE $1`, [`${PREFIX}%`]);
      await pool.query(`DELETE FROM autonomy_action_log WHERE task_id = $1`, [taskId]);
      await pool.query(`DELETE FROM kg_nodes WHERE id = ANY($1::uuid[])`, [nodeIds]);
    }
    await pool.end();
  });

  it('counts what each list tool shows, and only that', async () => {
    const source = createPrincipalBacklogSource(pool);
    const before = await source.counts();
    expect(before).toEqual(await reads());

    // One row of each kind that counts.
    await insertWarnedNode({});
    await insertApproval(60 * 60 * 1000);
    for (const status of OPEN_TASK_STATUSES) await insertTask('ceo', status);
    // Near misses: archived, anchored or unwarned nodes; expired or resolved approvals;
    // finished principal tasks and open tasks someone else owns.
    await insertWarnedNode({ archived: true });
    await insertWarnedNode({ identitySource: 'contact' });
    await insertWarnedNode({ warned: false });
    await insertApproval(-60 * 1000);
    await insertApproval(60 * 60 * 1000, 'approved');
    await insertTask('ceo', 'done');
    await insertTask('ceo', 'cancelled');
    await insertTask('curia', 'open');

    const after = await source.counts();
    expect(after).toEqual(await reads());
    expect(after).toEqual({
      decayWarnings: before.decayWarnings + 1,
      pendingApprovals: before.pendingApprovals + 1,
      principalTasks: before.principalTasks + OPEN_TASK_STATUSES.length,
    });
  });
});
