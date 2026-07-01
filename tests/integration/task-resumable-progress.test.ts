// task-resumable-progress.test.ts — round-trip persistence for progress.resumable (#1172).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { TaskRepo } from '../../src/db/task-repo.js';
import { WorkingDocsRepo } from '../../src/db/working-docs-repo.js';
import {
  RESUMABLE_BLOCK_MAX_BYTES,
  RESUMABLE_INLINE_ACCUMULATOR_MAX_BYTES,
  documentAccumulatorPointer,
  isDocumentPointer,
  resumableBlockBytes,
} from '../../src/db/resumable-progress.js';
import { accumulatorDocPath } from '../../src/db/resumable-accumulator-spill.js';
import {
  documentPointerFromTaskContent,
  resolveWorkspaceDirectoryPrefix,
} from '../../src/agents/document-workspace.js';
import type { EventBus } from '../../src/bus/bus.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'ResumableProgress Test';
const logger = pino({ level: 'silent' });
const noopBus = { publish: async () => {}, subscribe: () => {} } as unknown as EventBus;

async function cleanup(pool: pg.Pool): Promise<void> {
  const titleLike = `${PREFIX}%`;
  await pool.query(
    `DELETE FROM scheduled_jobs WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`,
    [titleLike],
  );
  await pool.query(
    `DELETE FROM working_document_links
      WHERE source_path IN (
        SELECT wd.path
        FROM working_documents wd
        INNER JOIN tasks t ON t.id = wd.task_id
        WHERE t.title LIKE $1
      )`,
    [titleLike],
  );
  await pool.query(
    `DELETE FROM working_documents
      WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`,
    [titleLike],
  );
  await pool.query(`DELETE FROM tasks WHERE title LIKE $1`, [titleLike]);
}

describeIf('TaskRepo resumable progress (#1172, #1210)', () => {
  let pool: pg.Pool;
  let repo: TaskRepo;
  let workingDocs: WorkingDocsRepo;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    workingDocs = new WorkingDocsRepo(pool, logger as never);
    repo = new TaskRepo(pool, noopBus, logger as never, 'UTC', workingDocs);
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

  it('stress: inline overflow auto-spills and progress stays under the cap', async () => {
    const task = await repo.createTask({
      agentId: 'social-media',
      title: `${PREFIX} stress spill`,
      source: 'coordinator',
    });

    let flagged: string[] = [];
    let accumulator: unknown = flagged;
    let spilled = false;

    for (let i = 0; i < 500; i++) {
      if (!spilled) {
        flagged = [...flagged, `did:plc:${String(i).padStart(6, '0')}`];
        accumulator = flagged;
      }

      const result = await repo.setResumableBlock(task.id, {
        cursor: String(i),
        done: i + 1,
        total: 1300,
        accumulator,
        lastSliceUnits: 25,
        next: 'Keep paging',
      }, 'social-media');

      expect('task' in result).toBe(true);
      if (!('task' in result)) return;

      if (!spilled && isDocumentPointer(result.block.accumulator)) {
        spilled = true;
        accumulator = result.block.accumulator;
        const doc = await workingDocs.read(result.block.accumulator.path);
        expect(doc?.body).toContain('"did:plc:');
      }

      expect(resumableBlockBytes(result.block)).toBeLessThanOrEqual(RESUMABLE_BLOCK_MAX_BYTES);
      const persisted = await repo.getResumableBlock(task.id);
      expect(persisted).not.toBeNull();
      expect(resumableBlockBytes(persisted!)).toBeLessThanOrEqual(RESUMABLE_BLOCK_MAX_BYTES);
    }

    expect(spilled).toBe(true);
  });

  it('returns inline_accumulator_overflow without silent truncate when spill is unavailable (#1172)', async () => {
    const repoNoSpill = new TaskRepo(pool, noopBus, logger as never, 'UTC');
    const task = await repoNoSpill.createTask({
      agentId: 'social-media',
      title: `${PREFIX} no-spill overflow`,
      source: 'coordinator',
    });

    const big = 'x'.repeat(RESUMABLE_INLINE_ACCUMULATOR_MAX_BYTES + 100);
    const result = await repoNoSpill.setResumableBlock(task.id, {
      cursor: 'page:1',
      done: 10,
      total: 1300,
      accumulator: [big],
      lastSliceUnits: 10,
      next: 'Continue paging',
    });

    expect(result).toMatchObject({ ok: false, code: 'inline_accumulator_overflow' });
    expect(await repoNoSpill.getResumableBlock(task.id)).toBeNull();
  });

  it('returns block_overflow when a non-accumulator field exceeds the cap (#1172)', async () => {
    const task = await repo.createTask({
      agentId: 'social-media',
      title: `${PREFIX} block overflow`,
      source: 'coordinator',
    });

    const result = await repo.setResumableBlock(task.id, {
      cursor: 'page:1',
      done: 10,
      total: 1300,
      accumulator: ['did:plc:abc'],
      lastSliceUnits: 10,
      next: 'x'.repeat(RESUMABLE_BLOCK_MAX_BYTES),
    });

    expect(result).toMatchObject({ ok: false, code: 'block_overflow' });
    expect(await repo.getResumableBlock(task.id)).toBeNull();
  });

  it('round-trip: child task spill, resume prefix, and continue from pointer', async () => {
    const parent = await repo.createTask({
      agentId: 'social-media',
      title: `${PREFIX} parent`,
      source: 'coordinator',
    });
    const child = await repo.createTask({
      agentId: 'social-media',
      title: `${PREFIX} child`,
      source: 'coordinator',
      parentTaskId: parent.id,
    });

    const flagged = Array.from({ length: 400 }, (_, i) => `did:plc:${String(i).padStart(6, '0')}`);
    const spill = await repo.setResumableBlock(child.id, {
      cursor: 'page:10',
      done: 400,
      total: 1300,
      accumulator: flagged,
      lastSliceUnits: 25,
      next: 'Review page 11 from workspace doc',
    }, 'social-media');
    expect('task' in spill).toBe(true);
    if (!('task' in spill)) return;

    const pointer = spill.block.accumulator;
    expect(isDocumentPointer(pointer)).toBe(true);
    if (!isDocumentPointer(pointer)) return;
    expect(pointer.path).toBe(accumulatorDocPath(parent.id));

    const doc = await workingDocs.read(pointer.path);
    expect(doc?.body).toContain('"did:plc:000000"');

    const wakeContent = JSON.stringify({
      task_id: child.id,
      progress: (await repo.getTask(child.id))?.progress ?? {},
    });
    expect(documentPointerFromTaskContent(wakeContent)?.path).toBe(pointer.path);
    expect(await resolveWorkspaceDirectoryPrefix(
      wakeContent,
      (taskId) => repo.resolveProjectRootTaskId(taskId),
    )).toBe(`/projects/${parent.id}/`);

    const resumed = await repo.setResumableBlock(child.id, {
      cursor: 'page:11',
      done: 425,
      total: 1300,
      accumulator: pointer,
      lastSliceUnits: 25,
      next: 'Finish remaining pages',
    }, 'social-media');
    expect('task' in resumed).toBe(true);
    if (!('task' in resumed)) return;
    expect(resumed.block.cursor).toBe('page:11');
    expect(resumed.block.accumulator).toEqual(pointer);
  });
});
