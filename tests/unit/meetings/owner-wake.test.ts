import { describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '../../../src/logger.js';
import { wakeAgendaOwner, type AgendaOwnerWakeDeps } from '../../../src/meetings/owner-wake.js';

const TASK_ID = '7e1f4c2a-5b3d-4e6f-8a9b-0c1d2e3f4a5b';

function deps(task: { status: string; agentId: string } | null, enqueue?: () => Promise<{ jobId: string }>) {
  const getTask = vi.fn().mockResolvedValue(task ? { id: TASK_ID, ...task } : null);
  const updateTask = vi.fn().mockResolvedValue(null);
  const enqueueTaskWake = vi.fn<(params: { taskId: string; agentId: string; createdBy?: string }) => Promise<{ jobId: string }>>(
    enqueue ?? (async () => ({ jobId: 'job-1' })),
  );
  const d = {
    taskRepo: { getTask, updateTask },
    scheduler: { enqueueTaskWake },
    logger: createSilentLogger(),
  } as unknown as AgendaOwnerWakeDeps;
  return { d, getTask, updateTask, enqueueTaskWake };
}

describe('wakeAgendaOwner', () => {
  it('notes the open coordinator task and wakes it as meetings', async () => {
    const { d, updateTask, enqueueTaskWake } = deps({ status: 'open', agentId: 'coordinator' });
    await wakeAgendaOwner(d, TASK_ID, 'Session starting');
    expect(updateTask).toHaveBeenCalledWith(TASK_ID, { progressNote: 'Session starting' });
    expect(enqueueTaskWake).toHaveBeenCalledTimes(1);
    expect(enqueueTaskWake.mock.calls[0]![0]).toMatchObject({ taskId: TASK_ID, agentId: 'coordinator', createdBy: 'meetings' });
  });

  it.each([
    ['a missing task', null],
    ['a done task', { status: 'done', agentId: 'coordinator' }],
    ['a cancelled task', { status: 'cancelled', agentId: 'coordinator' }],
    ['another agent\'s task', { status: 'open', agentId: 'ceo-inbox' }],
  ])('leaves %s alone', async (_label, task) => {
    const { d, updateTask, enqueueTaskWake } = deps(task);
    await wakeAgendaOwner(d, TASK_ID, 'note');
    expect(updateTask).not.toHaveBeenCalled();
    expect(enqueueTaskWake).not.toHaveBeenCalled();
  });

  it('treats a wake already pending as done', async () => {
    const { d } = deps({ status: 'open', agentId: 'coordinator' }, async () => {
      throw Object.assign(new Error('duplicate'), { code: '23505' });
    });
    await expect(wakeAgendaOwner(d, TASK_ID, 'note')).resolves.toBeUndefined();
  });

  it('propagates any other wake failure', async () => {
    const { d } = deps({ status: 'open', agentId: 'coordinator' }, async () => {
      throw new Error('db down');
    });
    await expect(wakeAgendaOwner(d, TASK_ID, 'note')).rejects.toThrow('db down');
  });
});
