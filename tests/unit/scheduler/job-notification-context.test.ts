import { describe, it, expect } from 'vitest';
import type { JobRow } from '../../../src/scheduler/scheduler-service.js';
import {
  buildJobConsoleUrl,
  buildJobNotificationContext,
  deriveJobObjective,
  deriveObjectiveFromPayload,
  formatJobRecurrence,
  formatUtcTimestamp,
} from '../../../src/scheduler/job-notification-context.js';

function makeJob(overrides: Partial<JobRow> = {}): JobRow {
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

describe('formatUtcTimestamp', () => {
  it('formats an ISO timestamp in UTC', () => {
    expect(formatUtcTimestamp('2026-07-03T08:00:00.000Z')).toBe('2026-07-03 08:00 UTC');
  });
});

describe('deriveObjectiveFromPayload', () => {
  it('prefers intent over task', () => {
    expect(deriveObjectiveFromPayload({ intent: 'Check inbox', task: 'other' })).toBe('Check inbox');
  });

  it('falls back to task field', () => {
    expect(deriveObjectiveFromPayload({ task: 'Send daily digest' })).toBe('Send daily digest');
  });

  it('combines skill and query', () => {
    expect(deriveObjectiveFromPayload({ skill: 'web-search', query: 'AI safety' })).toBe('web-search: AI safety');
  });

  it('handles task-wake envelopes', () => {
    expect(deriveObjectiveFromPayload({ type: 'task-wake', task_id: 't1' })).toBe('Task wake-up');
  });

  it('returns a fallback when payload has no recognizable fields', () => {
    expect(deriveObjectiveFromPayload({ foo: 1 })).toBe('(no objective recorded)');
  });
});

describe('deriveJobObjective', () => {
  it('prefers last_run_summary', () => {
    const job = makeJob({
      lastRunSummary: 'Compiled the daily digest.',
      intentAnchor: 'Daily digest',
      taskPayload: { task: 'ignored' },
    });
    expect(deriveJobObjective(job)).toBe('Compiled the daily digest.');
  });

  it('falls back to intent_anchor', () => {
    const job = makeJob({ intentAnchor: 'Weekly metrics summary' });
    expect(deriveJobObjective(job)).toBe('Weekly metrics summary');
  });

  it('falls back to task_payload', () => {
    const job = makeJob({ taskPayload: { task: 'Morning brief' } });
    expect(deriveJobObjective(job)).toBe('Morning brief');
  });
});

describe('formatJobRecurrence', () => {
  it('formats recurring cron jobs', () => {
    const job = makeJob({ cronExpr: '0 8 * * *', runAt: null });
    expect(formatJobRecurrence(job)).toBe('Recurring (cron: `0 8 * * *`)');
  });

  it('formats one-shot jobs', () => {
    const job = makeJob({ cronExpr: null, runAt: '2026-07-03T08:00:00.000Z' });
    expect(formatJobRecurrence(job)).toBe('One-shot (was due: `2026-07-03 08:00 UTC`)');
  });
});

describe('buildJobConsoleUrl', () => {
  it('uses appOrigin when configured', () => {
    expect(buildJobConsoleUrl('https://curia.example.com', 3000, 'job-1')).toBe(
      'https://curia.example.com/jobs/job-1',
    );
  });

  it('trims trailing slash on appOrigin', () => {
    expect(buildJobConsoleUrl('https://curia.example.com/', 3000, 'job-1')).toBe(
      'https://curia.example.com/jobs/job-1',
    );
  });

  it('falls back to localhost when appOrigin is unset', () => {
    expect(buildJobConsoleUrl(undefined, 4521, 'job-1')).toBe('http://localhost:4521/jobs/job-1');
  });
});

describe('buildJobNotificationContext', () => {
  it('assembles all context fields', () => {
    const job = makeJob({
      cronExpr: '0 8 * * *',
      runAt: null,
      lastRunSummary: 'Sent digest to CEO.',
    });
    expect(buildJobNotificationContext(job, 'https://curia.example.com', 3000)).toEqual({
      objective: 'Sent digest to CEO.',
      recurrence: 'Recurring (cron: `0 8 * * *`)',
      consoleUrl: 'https://curia.example.com/jobs/job-abc123',
    });
  });
});
