import { describe, it, expect } from 'vitest';
import { scheduledJobTask } from '../../scenarios/harness.js';
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
