import { describe, it, expect } from 'vitest';
import {
  createScheduleCreated,
  createScheduleFired,
  createScheduleSuspended,
} from '../../../src/bus/events.js';

describe('schedule event factories', () => {
  it('createScheduleCreated produces a valid event', () => {
    const event = createScheduleCreated({
      jobId: 'job-1',
      agentId: 'coordinator',
      cronExpr: '0 9 * * 1',
      runAt: null,
      taskPayload: { task: 'weekly report' },
      createdBy: 'system',
      parentEventId: 'parent-1',
    });

    expect(event.type).toBe('schedule.created');
    expect(event.sourceLayer).toBe('system');
    expect(event.payload.jobId).toBe('job-1');
    expect(event.payload.cronExpr).toBe('0 9 * * 1');
    expect(event.id).toBeTruthy();
    expect(event.timestamp).toBeInstanceOf(Date);
    expect(event.parentEventId).toBe('parent-1');
  });

  it('createScheduleFired produces a valid event', () => {
    const event = createScheduleFired({
      jobId: 'job-1',
      agentId: 'coordinator',
      agentTaskId: 'task-1',
      parentEventId: 'parent-1',
    });

    expect(event.type).toBe('schedule.fired');
    expect(event.sourceLayer).toBe('system');
    expect(event.payload.agentTaskId).toBe('task-1');
  });

  it('createScheduleSuspended produces a valid event', () => {
    const event = createScheduleSuspended({
      jobId: 'job-1',
      agentId: 'coordinator',
      lastError: 'timeout',
      consecutiveFailures: 3,
      parentEventId: 'parent-1',
    });

    expect(event.type).toBe('schedule.suspended');
    expect(event.sourceLayer).toBe('system');
    expect(event.payload.consecutiveFailures).toBe(3);
  });
});
