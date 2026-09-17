// scheduler-placeholder-interpolation.test.ts — #1800.
//
// `${principal_contact_id}` is resolved for agent system prompts by
// interpolateRuntimeContext(), but scheduled-job payloads went to the bus untouched. The
// daily calendar-holds-sweep cron in agents/calendar.yaml therefore told the model to
// "call calendar-holds-sweep with contactId set to ${principal_contact_id}", and the model
// did exactly that — literally.
//
// These tests pin both halves of the fix: the pure substitution, and the fire path that
// has to apply it before anything reaches the bus.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler, interpolateTaskContent } from '../../../src/scheduler/scheduler.js';

const PRINCIPAL_ID = '11111111-2222-4333-8444-555555555555';

// -- Mock helpers (mirror tests/unit/scheduler/scheduler.test.ts) --

function mockPool() {
  return { query: vi.fn() };
}

function mockBus() {
  return { publish: vi.fn(), subscribe: vi.fn() };
}

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function mockSchedulerService() {
  return {
    completeJobRun: vi.fn(),
    upsertDeclarativeJob: vi.fn(),
    cancelStaleDeclarativeJobs: vi.fn(),
    getJob: vi.fn(),
    nextRunFromCron: vi.fn(),
    recoverStuckJob: vi.fn(),
    pauseJobForDrift: vi.fn(),
  };
}

/** A due-job row with the column defaults the fire path reads. */
function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1', agent_id: 'calendar', cron_expr: '0 1 * * *',
    run_at: null, task_payload: { task: 'do work' }, status: 'pending',
    last_run_at: null, next_run_at: new Date(), last_error: null,
    consecutive_failures: 0, created_by: 'system', created_at: new Date(),
    timezone: 'UTC', agent_task_id: null, intent_anchor: null, progress: null,
    run_started_at: null, expected_duration_seconds: null,
    last_run_outcome: null, last_run_summary: null, last_run_context: null,
    ...overrides,
  };
}

describe('interpolateTaskContent', () => {
  it('substitutes the principal contact ID and reports the replacement count', () => {
    const result = interpolateTaskContent(
      '{"task":"sweep with contactId ${principal_contact_id} then verify ${principal_contact_id}"}',
      PRINCIPAL_ID,
    );

    expect(result.content).toBe(`{"task":"sweep with contactId ${PRINCIPAL_ID} then verify ${PRINCIPAL_ID}"}`);
    expect(result.principalReplacements).toBe(2);
    expect(result.principalResolved).toBe(true);
    expect(result.unresolvedTokens).toEqual([]);
  });

  it('leaves content and counters untouched when no token is present', () => {
    const content = '{"task":"send the weekly digest","scheduler_job_id":"job-1"}';
    const result = interpolateTaskContent(content, PRINCIPAL_ID);

    expect(result.content).toBe(content);
    expect(result.principalReplacements).toBe(0);
  });

  it('substitutes an empty string when no principal is resolved', () => {
    // Setup-required mode. Leaving the token would re-deliver the exact bug this fixes,
    // so the token goes away and the caller logs a warning instead.
    const result = interpolateTaskContent('{"task":"id=${principal_contact_id}"}', undefined);

    expect(result.content).toBe('{"task":"id="}');
    expect(result.principalReplacements).toBe(1);
    expect(result.principalResolved).toBe(false);
  });

  it('substitutes an empty string when the principal ID is not UUID-shaped', () => {
    // Defense-in-depth: a non-UUID value must never become free text in a model-visible
    // payload, matching interpolateRuntimeContext's guard on the same value.
    const result = interpolateTaskContent('{"task":"id=${principal_contact_id}"}', 'system');

    expect(result.content).toBe('{"task":"id="}');
    // A malformed ID is as unusable as a missing one, and must report itself the same way
    // — otherwise the fire path logs `resolved: true` over a value it discarded.
    expect(result.principalResolved).toBe(false);
  });

  it('produces valid JSON — a UUID needs no escaping, so substituting into the encoded text is safe', () => {
    const encoded = JSON.stringify({ task: 'contactId ${principal_contact_id}', scheduler_job_id: 'job-1' });
    const result = interpolateTaskContent(encoded, PRINCIPAL_ID);

    expect(() => JSON.parse(result.content)).not.toThrow();
    expect(JSON.parse(result.content)).toEqual({
      task: `contactId ${PRINCIPAL_ID}`,
      scheduler_job_id: 'job-1',
    });
  });

  it('reports other template tokens as unresolvable without substituting them', () => {
    const result = interpolateTaskContent(
      '{"task":"as of ${current_datetime} in ${timezone} for ${principal_contact_id}"}',
      PRINCIPAL_ID,
    );

    expect(result.unresolvedTokens).toEqual(['${current_datetime}', '${timezone}']);
    // Reported, not guessed at — the text is passed through unchanged.
    expect(result.content).toContain('${current_datetime}');
    expect(result.principalReplacements).toBe(1);
  });

  it('deduplicates repeated unresolvable tokens', () => {
    const result = interpolateTaskContent('${timezone} then ${timezone}', PRINCIPAL_ID);
    expect(result.unresolvedTokens).toEqual(['${timezone}']);
  });
});

describe('Scheduler fire path — placeholder resolution', () => {
  let pool: ReturnType<typeof mockPool>;
  let bus: ReturnType<typeof mockBus>;
  let logger: ReturnType<typeof mockLogger>;
  let schedulerService: ReturnType<typeof mockSchedulerService>;
  let scheduler: Scheduler;

  /** Build a scheduler; pass undefined to simulate setup-required mode. */
  function build(principalContactId: string | undefined) {
    return new Scheduler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool: pool as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bus: bus as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: logger as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      schedulerService: schedulerService as any,
      principalContactId,
    });
  }

  /** Capture the content of the agent.task event published by a single fire. */
  async function fireAndCaptureContent(row: Record<string, unknown>): Promise<string> {
    pool.query
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rowCount: 1 }); // claim update

    let content = '';
    bus.publish.mockImplementation((_layer: unknown, event: { type: string; payload?: { content?: string } }) => {
      if (event.type === 'agent.task') content = event.payload?.content ?? '';
      return Promise.resolve();
    });

    await scheduler.pollDueJobs();
    return content;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    pool = mockPool();
    bus = mockBus();
    logger = mockLogger();
    schedulerService = mockSchedulerService();
    scheduler = build(PRINCIPAL_ID);
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it('resolves the token in a top-level payload before publishing agent.task', async () => {
    // The real agents/calendar.yaml daily sweep payload.
    const content = await fireAndCaptureContent(jobRow({
      task_payload: {
        task: 'Run the calendar holds expiry sweep. Call calendar-holds-sweep with contactId set to ${principal_contact_id}.',
      },
    }));

    expect(content).toContain(PRINCIPAL_ID);
    expect(content).not.toContain('${principal_contact_id}');
  });

  it('resolves the token inside the nested task_payload of a task-bound job', async () => {
    // Task-bound jobs take the other branch of the content builder, which nests the
    // payload under `task_payload` — a per-branch fix would have missed this one.
    const content = await fireAndCaptureContent(jobRow({
      agent_task_id: 'task-9',
      task_payload: { task: 'contactId ${principal_contact_id}' },
      progress: {},
    }));

    const parsed = JSON.parse(content) as { task_payload: { task: string } };
    expect(parsed.task_payload.task).toBe(`contactId ${PRINCIPAL_ID}`);
    expect(content).not.toContain('${principal_contact_id}');
  });

  it('logs a searchable line when it resolves a placeholder', async () => {
    await fireAndCaptureContent(jobRow({
      task_payload: { task: 'contactId ${principal_contact_id}' },
    }));

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', agentId: 'calendar', replacements: 1, resolved: true }),
      'scheduler: resolved runtime placeholder ${principal_contact_id} in task payload',
    );
  });

  it('does not log placeholder resolution for an ordinary payload', async () => {
    await fireAndCaptureContent(jobRow({ task_payload: { task: 'send the weekly digest' } }));

    const messages = logger.info.mock.calls.map(c => c[1]);
    expect(messages).not.toContain('scheduler: resolved runtime placeholder ${principal_contact_id} in task payload');
  });

  it('warns and strips the token when no principal contact is resolved', async () => {
    scheduler.stop();
    scheduler = build(undefined);

    const content = await fireAndCaptureContent(jobRow({
      task_payload: { task: 'contactId ${principal_contact_id}' },
    }));

    expect(content).not.toContain('${principal_contact_id}');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1' }),
      expect.stringContaining('no usable principal contact ID'),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ resolved: false }),
      'scheduler: resolved runtime placeholder ${principal_contact_id} in task payload',
    );
  });

  it('warns when the configured principal ID is malformed rather than reporting success', async () => {
    scheduler.stop();
    scheduler = build('system');

    const content = await fireAndCaptureContent(jobRow({
      task_payload: { task: 'contactId ${principal_contact_id}' },
    }));

    expect(content).not.toContain('system');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1' }),
      expect.stringContaining('no usable principal contact ID'),
    );
  });

  it('warns about template tokens nothing can resolve', async () => {
    await fireAndCaptureContent(jobRow({
      task_payload: { task: 'as of ${current_datetime}' },
    }));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', tokens: ['${current_datetime}'] }),
      expect.stringContaining('unresolvable template tokens'),
    );
  });

  it('does not substitute into the prior-run block', async () => {
    // The prior-run block is a verbatim echo of what the agent reported last run.
    // Substituting there would let one run's prose place a real contact ID into the next
    // run's context, so interpolation is scoped to the payload and the block is prepended
    // afterwards.
    const content = await fireAndCaptureContent(jobRow({
      last_run_outcome: 'success',
      last_run_summary: 'swept holds for ${principal_contact_id}',
      task_payload: { task: 'run the sweep' },
    }));

    expect(content).toContain('swept holds for ${principal_contact_id}');
    expect(content).not.toContain(PRINCIPAL_ID);
  });
});
