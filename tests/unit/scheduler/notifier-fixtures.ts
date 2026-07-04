import { vi } from 'vitest';
import type { JobRow } from '../../../src/scheduler/scheduler-service.js';

export function mockSchedulerService(job: JobRow | null = null) {
  return {
    getJob: vi.fn().mockResolvedValue(job),
  };
}

export function makeJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 'job-abc123',
    agentId: 'coordinator',
    cronExpr: null,
    runAt: '2026-07-03T08:00:00.000Z',
    taskPayload: { task: 'Send daily digest' },
    status: 'pending',
    lastRunAt: null,
    nextRunAt: null,
    lastError: null,
    consecutiveFailures: 0,
    createdBy: 'system',
    createdAt: '2026-06-01T00:00:00.000Z',
    timezone: 'UTC',
    agentTaskId: null,
    intentAnchor: null,
    progress: null,
    taskErrorBudget: null,
    taskTags: null,
    taskTitle: null,
    runStartedAt: null,
    expectedDurationSeconds: null,
    lastRunOutcome: null,
    lastRunSummary: null,
    lastRunContext: null,
    originator: null,
    ...overrides,
  };
}
