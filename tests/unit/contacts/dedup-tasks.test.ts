import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { closeDedupTasksForMergedContact, reconcileOpenDedupTasks } from '../../../src/contacts/dedup-tasks.js';
import { dedupPairTag } from '../../../src/contacts/dedup-pair-key.js';
import type { Contact } from '../../../src/contacts/types.js';
import type { TaskRow } from '../../../src/db/queries/tasks.js';

const log = pino({ level: 'silent' });
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const C = '33333333-3333-3333-3333-333333333333';
const D = '44444444-4444-4444-4444-444444444444';

function task(id: string, x: string, y: string, over: Partial<TaskRow> = {}): TaskRow {
  return {
    id, status: 'open', owner: 'curia', createdAt: '2026-01-01T00:00:00.000Z', blockedByTaskId: null,
    tags: ['dedup', dedupPairTag(x, y)], description: null,
    ...over,
  } as TaskRow;
}

function repo(openTasks: TaskRow[], tasksById: Record<string, Partial<TaskRow>> = {}) {
  return {
    listTasks: vi.fn().mockResolvedValue(openTasks),
    getTask: vi.fn(async (id: string) => (tasksById[id] as TaskRow | undefined) ?? null),
    completeTask: vi.fn().mockResolvedValue({}),
    updateTask: vi.fn().mockResolvedValue({}),
  };
}

describe('closeDedupTasksForMergedContact', () => {
  it('closes sibling tasks naming the merged-away contact, but not the merged pair\'s own task', async () => {
    // "Merge all four" carried out as B → A: the tasks B/C and B/D are stranded.
    const r = repo([task('ab', A, B), task('bc', B, C), task('bd', D, B), task('cd', C, D)]);
    const closed = await closeDedupTasksForMergedContact(
      r as never, { survivorId: A, secondaryId: B, survivorName: 'Alice' }, log,
    );
    expect(closed).toBe(2);
    const ids = r.completeTask.mock.calls.map(c => c[0]);
    expect(ids.sort()).toEqual(['bc', 'bd']);
  });

  it('also closes the merged pair\'s task when asked (the scan\'s automatic merges)', async () => {
    const r = repo([task('ab', B, A)]);
    await closeDedupTasksForMergedContact(
      r as never, { survivorId: A, secondaryId: B, survivorName: 'Alice' }, log, { includeMergedPair: true },
    );
    expect(r.completeTask).toHaveBeenCalledWith('ab', expect.stringContaining('were merged'), 'contacts');
  });

  it('never throws: a listing failure is logged and reports zero', async () => {
    const r = repo([]);
    r.listTasks.mockRejectedValue(new Error('db down'));
    await expect(closeDedupTasksForMergedContact(
      r as never, { survivorId: A, secondaryId: B, survivorName: 'Alice' }, log,
    )).resolves.toBe(0);
  });
});

describe('reconcileOpenDedupTasks', () => {
  const contacts = new Map<string, Contact>([
    [A, { id: A, kind: 'person', tier: 'unknown' } as Contact],
    [B, { id: B, kind: 'person', tier: 'unknown' } as Contact],
  ]);

  it('reopens a task blocked on a task that has since closed', async () => {
    const t = task('ab', A, B, { status: 'blocked', blockedByTaskId: 'parent', tags: ['dedup', dedupPairTag(A, B), 'dedup-route:curia'] });
    const r = repo([t], { parent: { id: 'parent', status: 'done' } });
    const result = await reconcileOpenDedupTasks({
      taskRepo: r as never, openTasks: [t], contactsById: contacts, excludedPairKeys: new Set(), log,
    });
    expect(result.unblocked).toBe(1);
    expect(r.updateTask).toHaveBeenCalledWith('ab', expect.objectContaining({ status: 'open', blockedByTaskId: null }), 'contacts');
  });

  it('leaves a task blocked on an open task alone', async () => {
    const t = task('ab', A, B, { status: 'blocked', blockedByTaskId: 'parent', tags: ['dedup', dedupPairTag(A, B), 'dedup-route:curia'] });
    const r = repo([t], { parent: { id: 'parent', status: 'open' } });
    await reconcileOpenDedupTasks({
      taskRepo: r as never, openTasks: [t], contactsById: contacts, excludedPairKeys: new Set(), log,
    });
    expect(r.updateTask).not.toHaveBeenCalled();
  });

  it('counts a failed update and keeps the pair counted as open', async () => {
    const t = task('ab', A, B, { owner: 'ceo' });
    const r = repo([t]);
    r.updateTask.mockRejectedValue(new Error('boom'));
    const result = await reconcileOpenDedupTasks({
      taskRepo: r as never, openTasks: [t], contactsById: contacts, excludedPairKeys: new Set(), log,
    });
    expect(result.failed).toBe(1);
    expect(result.openPairKeys.size).toBe(1);
  });
});
