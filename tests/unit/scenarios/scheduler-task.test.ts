import { describe, it, expect } from 'vitest';
import { scheduledJobTask, taskWakeEvent } from '../../scenarios/harness.js';
import { makeSystemOriginator, isSystemOriginated } from '../../../src/contacts/principal.js';

// #2474 final fixes addendum R1: the harness's `from: scheduler` branch publishes what
// Scheduler.fireJob does for a declarative job, originator included. Without one, every autonomous
// case stopped at origin_unknown before the limits and the review it exists to test.
describe('scheduledJobTask', () => {
  it('stamps the originator fireJob restores for a declarative job', () => {
    const task = scheduledJobTask('ceo-inbox', 'conv-1', 'check the inbox');
    expect(task.payload.metadata?.['originator']).toEqual({ ...makeSystemOriginator(), initiatedAt: expect.any(String) });
    expect(isSystemOriginated(task.payload.metadata)).toBe(true);
  });

  it('keeps the rest of the published task as it was', () => {
    expect(scheduledJobTask('ceo-inbox', 'conv-1', 'check the inbox').payload).toMatchObject({
      agentId: 'ceo-inbox', conversationId: 'conv-1', channelId: 'scheduler', senderId: 'scheduler',
      content: JSON.stringify({ task: 'check the inbox' }),
    });
  });
});

// #2475: the inbox heartbeat creates its drain task with the system originator, and the wake job
// carries the task's originator into fireJob's metadata. A `from: task-wake` case with
// `originator: system` must publish the same, or its autonomous sends stop at origin_unknown.
describe('taskWakeEvent', () => {
  const task = { id: '7a1b2c3d-46a0-4b1c-8d2e-461a0b1c2d3e', title: 'Inbox drain', intent: 'Triage', notes: [{ at: 'x', note: 'y' }], tags: ['inbox-drain'] };

  it('stamps the system originator when the wake task names it', () => {
    const event = taskWakeEvent('ceo-inbox', 'conv-1', 'wake body', { ...task, originator: 'system' });
    expect(isSystemOriginated(event.payload.metadata)).toBe(true);
    expect(event.payload.metadata?.['boundTask']).toMatchObject({ taskId: task.id, tags: ['inbox-drain'], createdBy: 'heartbeat' });
  });

  it('carries no originator when the wake task names none (a plain wake_at job)', () => {
    const event = taskWakeEvent('ceo-inbox', 'conv-1', 'wake body', task);
    expect(event.payload.metadata).not.toHaveProperty('originator');
    expect(event.payload).toMatchObject({ agentId: 'ceo-inbox', conversationId: 'conv-1', channelId: 'scheduler', senderId: 'scheduler', content: 'wake body', intentAnchor: 'Triage' });
  });
});
