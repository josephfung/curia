// principal-backlog.test.ts — the backlog counts against real Postgres (prompt trim PR 7).
//
// The backlog line tells the coordinator how many items each list tool will show, so each
// count must match its tool's read: decay-warnings-list (KnowledgeGraphStore.listDecayWarnings),
// list-pending-actions (ActionLogRepo.findAllPending) and task-list with owner `ceo` and the
// open statuses (TaskRepo.listTasks). The shared database may hold other rows, and other test
// files write to the same tables while this one runs, so nothing here compares two moments:
// each check reads the counts and the lists in one REPEATABLE READ snapshot (they must agree),
// and this test's own rows are checked by id, each kind present in its list and each near
// miss absent. (Comparing a count with a later read, or a count with an earlier count, failed
// under sharded CI when another file finished and deleted its open principal tasks in between.)

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { OPEN_TASK_STATUSES } from '../../src/agents/prompts/backlog-line.js';
import { ActionLogRepo } from '../../src/autonomy/action-log-repo.js';
import type { EventBus } from '../../src/bus/bus.js';
import type { DbPool } from '../../src/db/connection.js';
import { TaskRepo } from '../../src/db/task-repo.js';
import { createPrincipalBacklogSource, readAwaitingAnswers } from '../../src/dispatch/principal-backlog.js';
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
  const nodeIds: string[] = [];
  const taskId = `principal-backlog-test-${randomUUID()}`;
  // The suite writes a pending email-send approval and principal-owned tasks, which a real
  // instance would surface or act on, so it runs only against curia_test.
  let dbVerified = false;

  async function insertWarnedNode(opts: { archived?: boolean; identitySource?: 'label' | 'contact'; warned?: boolean }): Promise<string> {
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
    return rows[0]!.id;
  }

  async function insertApproval(expiresInMs: number, outcome: 'pending_approval' | 'approved' = 'pending_approval'): Promise<number> {
    return actions.insert({
      taskId,
      toolName: 'email-send',
      actionRisk: 'medium',
      outcome,
      expiresAt: new Date(Date.now() + expiresInMs),
      description: PREFIX,
    });
  }

  async function insertTask(owner: 'ceo' | 'curia', status: string): Promise<string> {
    const task = await tasks.createTask({ agentId: 'coordinator', title: `${PREFIX} ${owner} ${status}`, owner, source: 'coordinator' });
    if (status !== 'open') {
      await pool.query(`UPDATE tasks SET status = $1 WHERE id = $2`, [status, task.id]);
    }
    return task.id;
  }

  /**
   * The backlog counts and the three list tools' reads, all in one REPEATABLE READ snapshot on
   * one connection, so a concurrent writer cannot land between them. Each reader gets the
   * snapshot's connection as its pool: every one of them reads with a single `query`.
   */
  async function snapshot() {
    const client = await pool.connect();
    // Set when the connection must not go back to the pool for reuse: a failed read
    // leaves the transaction aborted, and a ROLLBACK that also fails leaves it unknown.
    let broken: Error | undefined;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const db = { query: client.query.bind(client) } as unknown as DbPool;
      const counts = await createPrincipalBacklogSource(db).counts();
      const lists = {
        decayWarnings: (await KnowledgeGraphStore.createWithPostgres(db, EmbeddingService.createForTesting(), logger as never).listDecayWarnings()).map((w) => w.nodeId),
        pendingApprovals: (await new ActionLogRepo(db, logger as never).findAllPending()).map((a) => a.id),
        principalTasks: (await new TaskRepo(db, noopBus, logger as never, 'UTC').listTasks({ owner: 'ceo', statuses: [...OPEN_TASK_STATUSES], limit: 100_000 })).map((t) => t.id),
      };
      await client.query('COMMIT');
      return { counts, lists };
    } catch (err) {
      // Roll back so the pool never hands out a connection inside an aborted
      // transaction (afterAll's cleanup would fail on it); the read's own error is
      // the one the test reports.
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        broken = rollbackErr as Error;
      }
      throw err;
    } finally {
      // release(err) makes the pool destroy the connection instead of reusing it.
      client.release(broken);
    }
  }

  function expectCountsMatchLists(snap: Awaited<ReturnType<typeof snapshot>>): void {
    expect(snap.counts).toEqual({
      decayWarnings: snap.lists.decayWarnings.length,
      pendingApprovals: snap.lists.pendingApprovals.length,
      principalTasks: snap.lists.principalTasks.length,
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    dbVerified = true;
    tasks = new TaskRepo(pool, noopBus, logger as never, 'UTC');
    actions = new ActionLogRepo(pool, logger as never);
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
    expectCountsMatchLists(await snapshot());

    // One row of each kind that counts.
    const warned = await insertWarnedNode({});
    const pending = await insertApproval(60 * 60 * 1000);
    const openTasks: string[] = [];
    for (const status of OPEN_TASK_STATUSES) openTasks.push(await insertTask('ceo', status));
    // Near misses: archived, anchored or unwarned nodes; expired or resolved approvals;
    // finished principal tasks and open tasks someone else owns.
    const missNodes = [
      await insertWarnedNode({ archived: true }),
      await insertWarnedNode({ identitySource: 'contact' }),
      await insertWarnedNode({ warned: false }),
    ];
    const missApprovals = [await insertApproval(-60 * 1000), await insertApproval(60 * 60 * 1000, 'approved')];
    const missTasks = [await insertTask('ceo', 'done'), await insertTask('ceo', 'cancelled'), await insertTask('curia', 'open')];

    const after = await snapshot();
    expectCountsMatchLists(after);
    expect(after.lists.decayWarnings).toContain(warned);
    expect(after.lists.pendingApprovals).toContain(pending);
    expect(after.lists.principalTasks).toEqual(expect.arrayContaining(openTasks));
    for (const id of missNodes) expect(after.lists.decayWarnings).not.toContain(id);
    for (const id of missApprovals) expect(after.lists.pendingApprovals).not.toContain(id);
    for (const id of missTasks) expect(after.lists.principalTasks).not.toContain(id);
  });

  // The approvals a principal turn may be answering (#2333): pending, unexpired, shown.
  it('lists the pending approvals the principal was shown, the one replied to on its thread first', async () => {
    const conversationId = `principal-backlog-awaiting-${randomUUID()}`;
    const insert = async (opts: { expiresInMs?: number; outcome?: 'pending_approval' | 'approved'; shown?: boolean; description: string; ask?: boolean }): Promise<number> => {
      const id = await actions.insert({
        taskId,
        conversationId,
        toolName: 'signal-send',
        actionRisk: 'medium',
        outcome: opts.outcome ?? 'pending_approval',
        shortRef: randomUUID().replace(/-/g, '').slice(0, 8),
        expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 60 * 60 * 1000)),
        description: opts.description,
        ...(opts.ask ? { disclosureAsk: { conversationId, labels: ['email'], requester: '+15195550177', counterparties: ['+15195550177'], requesterName: 'Dana Whitfield' } } : {}),
      });
      if (opts.shown !== false) await actions.claimNotification(id);
      return id;
    };
    const older = await insert({ description: `${PREFIX} older`, ask: true });
    await insert({ description: `${PREFIX} newer` });
    // Near misses: never shown, expired, resolved.
    await insert({ description: `${PREFIX} unshown`, shown: false });
    await insert({ description: `${PREFIX} expired`, expiresInMs: -60 * 1000 });
    await insert({ description: `${PREFIX} approved`, outcome: 'approved' });
    await actions.bindDeliveryMessage(older, 'email-thread', `thread-${conversationId}`);

    const source = createPrincipalBacklogSource(pool, actions);
    const plain = await readAwaitingAnswers(actions, { conversationIds: [conversationId] });
    expect(plain.map((a) => a.description)).toEqual([`${PREFIX} newer`, `${PREFIX} older`]);
    expect(plain[1]!.question).toContain('Dana Whitfield (+15195550177) is asking for your email address');
    expect(plain.some((a) => a.repliedTo)).toBe(false);

    const replied = await readAwaitingAnswers(actions, { conversationIds: [conversationId], replyThreadId: `thread-${conversationId}` });
    expect(replied.map((a) => [a.description, a.repliedTo === true])).toEqual([[`${PREFIX} older`, true], [`${PREFIX} newer`, false]]);
    // Production's source reads every conversation: it holds these too.
    const all = await source.awaitingAnswers!({ replyThreadId: `thread-${conversationId}` });
    expect(all[0]).toMatchObject({ description: `${PREFIX} older`, repliedTo: true });
  });
});
