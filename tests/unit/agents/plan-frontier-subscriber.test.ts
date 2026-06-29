import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../../../src/bus/bus.js';
import {
  createScheduleFired,
  createTaskCompleted,
  createTaskUpdated,
} from '../../../src/bus/events.js';
import { PlanFrontierSubscriber } from '../../../src/agents/plan-frontier-subscriber.js';
import * as planFrontier from '../../../src/agents/plan-frontier.js';

function mockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() };
}

describe('PlanFrontierSubscriber', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('schedules a parent wake on terminal task.updated', async () => {
    const handleSpy = vi.spyOn(planFrontier, 'handleChildTerminalResolution').mockResolvedValue();

    const bus = new EventBus(mockLogger() as never);
    const subscriber = new PlanFrontierSubscriber({
      pool: {} as never,
      bus,
      logger: mockLogger() as never,
      schedulerService: {} as never,
      taskRepo: { getTask: vi.fn() } as never,
      eligibleAgents: new Set(['coordinator']),
      continuationDelaySeconds: 30,
    });
    subscriber.start();

    await bus.publish('execution', createTaskUpdated({
      taskId: 'child-1',
      previousStatus: 'open',
      newStatus: 'done',
      agentId: 'coordinator',
    }));

    expect(handleSpy).toHaveBeenCalledWith(expect.objectContaining({ childTaskId: 'child-1' }));
  });

  it('schedules a parent wake on task.completed', async () => {
    const handleSpy = vi.spyOn(planFrontier, 'handleChildTerminalResolution').mockResolvedValue();

    const bus = new EventBus(mockLogger() as never);
    const subscriber = new PlanFrontierSubscriber({
      pool: {} as never,
      bus,
      logger: mockLogger() as never,
      schedulerService: {} as never,
      taskRepo: { getTask: vi.fn() } as never,
      eligibleAgents: new Set(['coordinator']),
      continuationDelaySeconds: 30,
    });
    subscriber.start();

    await bus.publish('execution', createTaskCompleted({
      taskId: 'child-1',
      agentId: 'coordinator',
    }));

    expect(handleSpy).toHaveBeenCalledWith(expect.objectContaining({ childTaskId: 'child-1' }));
  });

  it('ignores non-terminal task.updated events', async () => {
    const handleSpy = vi.spyOn(planFrontier, 'handleChildTerminalResolution').mockResolvedValue();

    const bus = new EventBus(mockLogger() as never);
    const subscriber = new PlanFrontierSubscriber({
      pool: {} as never,
      bus,
      logger: mockLogger() as never,
      schedulerService: {} as never,
      taskRepo: { getTask: vi.fn() } as never,
      eligibleAgents: new Set(['coordinator']),
      continuationDelaySeconds: 30,
    });
    subscriber.start();

    await bus.publish('execution', createTaskUpdated({
      taskId: 'child-1',
      previousStatus: 'open',
      newStatus: 'in_progress',
      agentId: 'coordinator',
    }));

    expect(handleSpy).not.toHaveBeenCalled();
  });

  it('advances the frontier when a planned parent wake fires', async () => {
    const advanceSpy = vi.spyOn(planFrontier, 'advancePlanFrontier').mockResolvedValue({
      rollup: { done: 1, total: 3 },
      rollupUpdated: true,
      dispatchedChildIds: ['child-2'],
    });

    const bus = new EventBus(mockLogger() as never);
    const taskRepo = {
      getTask: vi.fn().mockResolvedValue({
        id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
        progress: {
          plan: {
            steps: [{ id: 'step-1', taskId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }],
            deliverableStepId: null,
            done: 0,
            total: 1,
            next: 'Continue',
          },
        },
      }),
    };

    const subscriber = new PlanFrontierSubscriber({
      pool: {} as never,
      bus,
      logger: mockLogger() as never,
      schedulerService: {} as never,
      taskRepo: taskRepo as never,
      eligibleAgents: new Set(['coordinator']),
      continuationDelaySeconds: 30,
    });
    subscriber.start();

    await bus.publish('system', createScheduleFired({
      jobId: 'job-1',
      agentId: 'coordinator',
      agentTaskId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      parentEventId: 'parent-event',
    }));

    expect(advanceSpy).toHaveBeenCalledWith(expect.objectContaining({
      parentTaskId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    }));
  });
});
