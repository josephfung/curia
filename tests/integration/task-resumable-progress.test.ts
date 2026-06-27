// task-resumable-progress.test.ts — round-trip persistence for progress.resumable (#1172).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { TaskRepo } from '../../src/db/task-repo.js';
import {
  RESUMABLE_BLOCK_MAX_BYTES,
  RESUMABLE_INLINE_ACCUMULATOR_MAX_BYTES,
  documentAccumulatorPointer,
  resumableBlockBytes,
  inlineAccumulatorBytes,
} from '../../src/db/resumable-progress.js';
import type { EventBus } from '../../src/bus/bus.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'ResumableProgress Test';
const logger = pino({ level: 'silent' });
const noopBus = { publish: async () => {}, subscribe: () => {} } as unknown as EventBus;

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query(
    `DELETE FROM scheduled_jobs WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`,
    [`${PREFIX}%`],
  );
  await pool.query(`DELETE FROM tasks WHERE title LIKE $1`, [`${PREFIX}%`]);
}

describeIf('TaskRepo resumable progress (#1172)', () => {
  let pool: pg.Pool;
  let repo: TaskRepo;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    repo = new TaskRepo(pool, noopBus, logger as never, 'UTC');
  });
  afterAll(async () => { await cleanup(pool); await pool.end(); });
  beforeEach(async () => { await cleanup(pool); });

  it('round-trips a resumable block and resumes from the cursor', async () => {
    const task = await repo.createTask({
      agentId: 'social-media',
      title: `${PREFIX} audit`,
      source: 'coordinator',
    });

    const first = await repo.setResumableBlock(task.id, {
      cursor: 'page:3',
      done: 300,
      total: 1300,
      accumulator: ['did:plc:abc', 'did:plc:def'],
      lastSliceUnits: 25,
      next: 'Review page 4',
    });
    expect('task' in first).toBe(true);
    if (!('task' in first)) return;

    const reread = await repo.getResumableBlock(task.id);
    expect(reread?.cursor).toBe('page:3');
    expect(reread?.done).toBe(300);
    expect(reread?.accumulator).toEqual(['did:plc:abc', 'did:plc:def']);

    const second = await repo.setResumableBlock(task.id, {
      cursor: 'page:4',
      done: 325,
      total: 1300,
      accumulator: ['did:plc:abc', 'did:plc:def', 'did:plc:ghi'],
      lastSliceUnits: 25,
      next: 'Review page 5',
    });
    expect('task' in second).toBe(true);
    if (!('task' in second)) return;

    const resumed = await repo.getResumableBlock(task.id);
    expect(resumed?.cursor).toBe('page:4');
    expect(resumed?.done).toBe(325);

    const reloaded = await repo.getTask(task.id);
    expect((reloaded?.progress as { notes?: unknown[] }).notes).toEqual([]);
  });

  it('does not clobber concurrent progress.notes when checkpointing', async () => {
    const task = await repo.createTask({
      agentId: 'social-media',
      title: `${PREFIX} notes`,
      source: 'coordinator',
    });

    await repo.updateTask(task.id, { progressNote: 'Slice 1 complete' }, 'social-media');

    const result = await repo.setResumableBlock(task.id, {
      cursor: 'page:2',
      done: 50,
      total: 1300,
      accumulator: ['did:plc:abc'],
      lastSliceUnits: 25,
      next: 'Review page 3',
    });
    expect('task' in result).toBe(true);

    const reloaded = await repo.getTask(task.id);
    const notes = (reloaded?.progress as { notes?: Array<{ note: string }> }).notes ?? [];
    expect(notes.some((n) => n.note === 'Slice 1 complete')).toBe(true);
    expect(await repo.getResumableBlock(task.id)).toMatchObject({ cursor: 'page:2', done: 50 });
  });

  it('persists a document pointer accumulator', async () => {
    const task = await repo.createTask({
      agentId: 'social-media',
      title: `${PREFIX} spilled`,
      source: 'coordinator',
    });

    const pointer = documentAccumulatorPointer('/projects/audit/findings.md', 'flagged');
    const result = await repo.setResumableBlock(task.id, {
      cursor: 'page:10',
      done: 1000,
      total: 1300,
      accumulator: pointer,
      lastSliceUnits: 25,
      next: 'Finish remaining pages from workspace doc',
    });
    expect('task' in result).toBe(true);

    const block = await repo.getResumableBlock(task.id);
    expect(block?.accumulator).toEqual(pointer);
  });

  it('stress: repeated checkpoints cannot grow progress.resumable past the cap', async () => {
    const task = await repo.createTask({
      agentId: 'social-media',
      title: `${PREFIX} stress`,
      source: 'coordinator',
    });

    let flagged: string[] = [];
    let lastGoodBlock = await repo.getResumableBlock(task.id);

    for (let i = 0; i < 500; i++) {
      flagged = [...flagged, `did:plc:${String(i).padStart(6, '0')}`];
      const result = await repo.setResumableBlock(task.id, {
        cursor: String(i),
        done: i + 1,
        total: 1300,
        accumulator: flagged,
        lastSliceUnits: 25,
        next: 'Keep paging',
      });

      if (!('task' in result)) {
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe('inline_accumulator_overflow');
        expect(lastGoodBlock).not.toBeNull();
        expect(resumableBlockBytes(lastGoodBlock!)).toBeLessThanOrEqual(RESUMABLE_BLOCK_MAX_BYTES);
        expect(inlineAccumulatorBytes(lastGoodBlock!.accumulator)).toBeLessThanOrEqual(
          RESUMABLE_INLINE_ACCUMULATOR_MAX_BYTES,
        );
        return;
      }

      lastGoodBlock = result.block;
      const persisted = await repo.getResumableBlock(task.id);
      expect(persisted).not.toBeNull();
      expect(resumableBlockBytes(persisted!)).toBeLessThanOrEqual(RESUMABLE_BLOCK_MAX_BYTES);
    }

    throw new Error('expected inline accumulator overflow before 500 iterations');
  });
});
