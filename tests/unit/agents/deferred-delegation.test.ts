// A retry wake that cannot be read back must not be written.

import { describe, it, expect, vi } from 'vitest';
import { enqueueUndispatchedDelegation } from '../../../src/agents/deferred-delegation.js';
import type { TaskRepo } from '../../../src/db/task-repo.js';
import { createLogger } from '../../../src/logger.js';

describe('enqueueUndispatchedDelegation', () => {
  it('refuses a wake whose channel or sender would not survive the fire-time read', async () => {
    const createTask = vi.fn();
    const taskRepo = { createTask } as unknown as TaskRepo;
    const result = await enqueueUndispatchedDelegation({
      taskRepo,
      logger: createLogger('error'),
      originAgentId: 'coordinator',
      originConversationId: 'signal:+15551212',
      originChannelId: '',
      originSenderId: '',
      targetAgent: 'calendar',
      brief: 'Reserve the room',
      wakeAt: new Date(Date.now() + 60_000),
      attempt: 1,
    });

    expect(result).toBe('unavailable');
    expect(createTask).not.toHaveBeenCalled();
  });
});
