// task-repo-list-pagination.test.ts — keyset pagination for TaskRepo.listTasks / listAllTasks
// against real Postgres (#1433). Verifies that paging through a >100-task dataset is
// deterministic (no skipped or duplicated rows), order-equivalent to a single unbounded fetch,
// and that the listAllTasks safety ceiling caps the total with a logged warning.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { TaskRepo } from '../../src/db/task-repo.js';
import type { EventBus } from '../../src/bus/bus.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'TaskRepoPage Test';
const logger = pino({ level: 'silent' });
const noopBus = { publish: async () => {}, subscribe: () => {} } as unknown as EventBus;

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query(`DELETE FROM tasks WHERE title LIKE $1`, [`${PREFIX}%`]);
}

describeIf('TaskRepo keyset pagination (#1433)', () => {
  let pool: pg.Pool;
  let repo: TaskRepo;
  const TOTAL = 250;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    repo = new TaskRepo(pool, noopBus, logger as never, 'UTC');
    await cleanup(pool);
    // Seed a dataset with heavy ties in the sort key so the id tiebreaker is genuinely exercised:
    // priorities repeat across a small set, and roughly a third of rows have a null due_at (the
    // NULLS-LAST tail). i drives all three so the mix is deterministic.
    for (let i = 0; i < TOTAL; i++) {
      const priority = 10 + (i % 5) * 10; // 10,20,30,40,50 repeating
      const dueAt = i % 3 === 0 ? undefined : new Date(1_720_000_000_000 + (i % 7) * 86_400_000);
      await repo.createTask({
        agentId: 'coordinator',
        title: `${PREFIX} ${String(i).padStart(4, '0')}`,
        owner: 'ceo',
        source: 'coordinator',
        priority,
        dueAt,
      });
    }
  });
  afterAll(async () => { await cleanup(pool); await pool.end(); });

  it('listAllTasks returns every matching row with no skips or duplicates', async () => {
    const all = await repo.listAllTasks(
      { owner: 'ceo', statuses: ['open'] },
      { pageSize: 40 },
    );
    // Restrict to this test's rows (the shared DB may hold unrelated ceo tasks).
    const mine = all.filter((t) => t.title.startsWith(PREFIX));
    expect(mine).toHaveLength(TOTAL);
    const ids = new Set(mine.map((t) => t.id));
    expect(ids.size).toBe(TOTAL); // no duplicates
  });

  it('paged traversal is order-equivalent to a single unbounded fetch', async () => {
    // Ground truth: one big page (limit above TOTAL) in the same deterministic order.
    const single = (await repo.listTasks({ owner: 'ceo', statuses: ['open'], limit: 10_000 }))
      .filter((t) => t.title.startsWith(PREFIX));
    const paged = (await repo.listAllTasks({ owner: 'ceo', statuses: ['open'] }, { pageSize: 37 }))
      .filter((t) => t.title.startsWith(PREFIX));
    expect(paged.map((t) => t.id)).toEqual(single.map((t) => t.id));

    // And the order actually honors priority DESC, due_at ASC NULLS LAST, id ASC.
    for (let i = 1; i < single.length; i++) {
      const prev = single[i - 1]!;
      const cur = single[i]!;
      if (prev.priority !== cur.priority) {
        expect(prev.priority).toBeGreaterThan(cur.priority);
        continue;
      }
      // Same priority → due_at ascending with nulls last, id ascending on ties.
      const prevNull = prev.dueAt === null;
      const curNull = cur.dueAt === null;
      if (prevNull || curNull) {
        // A non-null must never come after a null (nulls sort last).
        if (prevNull && !curNull) throw new Error('null due_at sorted before a non-null');
        if (prevNull && curNull) expect(prev.id < cur.id).toBe(true);
        continue;
      }
      if (prev.dueAt !== cur.dueAt) {
        expect(prev.dueAt! <= cur.dueAt!).toBe(true);
      } else {
        expect(prev.id < cur.id).toBe(true);
      }
    }
  });

  it('a single explicit cursor page resumes exactly after the prior page', async () => {
    const page1 = await repo.listTasks({ owner: 'ceo', statuses: ['open'], limit: 50 });
    const last = page1[page1.length - 1]!;
    const page2 = await repo.listTasks({
      owner: 'ceo',
      statuses: ['open'],
      limit: 50,
      cursor: { priority: last.priority, dueAt: last.dueAt, id: last.id },
    });
    const page1Ids = new Set(page1.map((t) => t.id));
    // No overlap between the two pages.
    expect(page2.some((t) => page1Ids.has(t.id))).toBe(false);
  });

  it('listAllTasks enforces the safety ceiling and logs a warning', async () => {
    const warnings: unknown[] = [];
    const capLogger = pino(
      { level: 'warn' },
      { write: (msg: string) => warnings.push(JSON.parse(msg)) },
    );
    const capRepo = new TaskRepo(pool, noopBus, capLogger as never, 'UTC');
    const capped = await capRepo.listAllTasks(
      { owner: 'ceo', statuses: ['open'] },
      { pageSize: 40, maxTasks: 100 },
    );
    expect(capped).toHaveLength(100);
    expect(warnings.some((w) => JSON.stringify(w).includes('safety ceiling'))).toBe(true);
  });
});
