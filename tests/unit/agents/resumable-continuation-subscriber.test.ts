import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../../../src/bus/bus.js';
import { createAgentResponse } from '../../../src/bus/events.js';
import { ResumableContinuationSubscriber } from '../../../src/agents/resumable-continuation-subscriber.js';
import * as continuation from '../../../src/agents/resumable-continuation.js';

function mockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() };
}

describe('ResumableContinuationSubscriber', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('schedules a continuation when execution_paused is emitted', async () => {
    const scheduleSpy = vi.spyOn(continuation, 'scheduleResumableContinuation')
      .mockResolvedValue({ scheduled: true, jobId: 'job-1', agentId: 'social-media', runAt: new Date() });

    const bus = new EventBus(mockLogger() as never);
    const subscriber = new ResumableContinuationSubscriber({
      pool: {} as never,
      bus,
      logger: mockLogger() as never,
      schedulerService: {} as never,
      eligibleAgents: new Set(['social-media']),
      continuationDelaySeconds: 30,
    });
    subscriber.start();

    await bus.publish('agent', createAgentResponse({
      agentId: 'social-media',
      conversationId: 'conv-1',
      content: JSON.stringify({
        _curia_protocol: 'execution_paused',
        task_id: 'task-abc',
        done: 25,
        total: 1300,
        cursor: 'page:3',
        last_slice_units: 25,
        next: 'Review page 4',
      }),
      parentEventId: 'parent-1',
    }));

    expect(scheduleSpy).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-abc',
      delaySeconds: 30,
    }));
  });

  it('ignores non-paused responses', async () => {
    const scheduleSpy = vi.spyOn(continuation, 'scheduleResumableContinuation')
      .mockResolvedValue({ scheduled: true, jobId: 'job-1', agentId: 'social-media', runAt: new Date() });

    const bus = new EventBus(mockLogger() as never);
    const subscriber = new ResumableContinuationSubscriber({
      pool: {} as never,
      bus,
      logger: mockLogger() as never,
      schedulerService: {} as never,
      eligibleAgents: new Set(['social-media']),
      continuationDelaySeconds: 30,
    });
    subscriber.start();

    await bus.publish('agent', createAgentResponse({
      agentId: 'social-media',
      conversationId: 'conv-1',
      content: 'All done.',
      parentEventId: 'parent-1',
    }));

    expect(scheduleSpy).not.toHaveBeenCalled();
  });
});
