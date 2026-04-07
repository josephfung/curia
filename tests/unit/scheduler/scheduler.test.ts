import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler, POLL_INTERVAL_MS } from '../../../src/scheduler/scheduler.js';
import type { AgentYamlConfig } from '../../../src/agents/loader.js';

// -- Mock helpers --

function mockPool() {
  return { query: vi.fn() };
}

function mockBus() {
  return {
    publish: vi.fn(),
    subscribe: vi.fn(),
  };
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
    getJob: vi.fn(),
    nextRunFromCron: vi.fn(),
  };
}

// Helper to build a fake DB row (snake_case, as returned by pool.query).
function fakeDbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    agent_id: 'agent-1',
    cron_expr: '0 9 * * *',
    run_at: null,
    task_payload: { skill: 'morning-brief' },
    status: 'pending',
    last_run_at: null,
    next_run_at: new Date().toISOString(),
    last_error: null,
    consecutive_failures: 0,
    created_by: 'system',
    created_at: new Date().toISOString(),
    agent_task_id: null,
    intent_anchor: null,
    progress: null,
    ...overrides,
  };
}

describe('Scheduler', () => {
  let pool: ReturnType<typeof mockPool>;
  let bus: ReturnType<typeof mockBus>;
  let logger: ReturnType<typeof mockLogger>;
  let schedulerService: ReturnType<typeof mockSchedulerService>;
  let scheduler: Scheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    pool = mockPool();
    bus = mockBus();
    logger = mockLogger();
    schedulerService = mockSchedulerService();
    scheduler = new Scheduler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool: pool as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bus: bus as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: logger as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      schedulerService: schedulerService as any,
    });
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  // -- start / stop --

  describe('start / stop', () => {
    it('subscribes to agent.response and agent.error on system layer', () => {
      scheduler.start();

      expect(bus.subscribe).toHaveBeenCalledTimes(2);

      const [type1, layer1] = bus.subscribe.mock.calls[0] as [string, string];
      expect(type1).toBe('agent.response');
      expect(layer1).toBe('system');

      const [type2, layer2] = bus.subscribe.mock.calls[1] as [string, string];
      expect(type2).toBe('agent.error');
      expect(layer2).toBe('system');
    });

    it('starts an interval that calls pollDueJobs', async () => {
      // Make pollDueJobs a no-op by returning no rows
      pool.query.mockResolvedValue({ rows: [] });

      scheduler.start();

      // Advance by one interval
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      // pool.query should have been called by pollDueJobs
      expect(pool.query).toHaveBeenCalled();
    });

    it('stop clears the interval', async () => {
      pool.query.mockResolvedValue({ rows: [] });

      scheduler.start();
      scheduler.stop();

      // Reset the call count
      pool.query.mockClear();

      // Advance past several intervals — no more calls should happen
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

      expect(pool.query).not.toHaveBeenCalled();
    });
  });

  // -- pollDueJobs --

  describe('pollDueJobs', () => {
    it('does nothing when no jobs are due', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await scheduler.pollDueJobs();

      // Only the SELECT query, no UPDATEs or bus publishes
      expect(pool.query).toHaveBeenCalledOnce();
      expect(bus.publish).not.toHaveBeenCalled();
    });

    it('claims due jobs and fires them (publishes schedule.fired + agent.task)', async () => {
      const row = fakeDbRow();
      // First call: SELECT due jobs
      pool.query.mockResolvedValueOnce({ rows: [row] });
      // Second call: UPDATE status to running
      pool.query.mockResolvedValueOnce({ rows: [] });

      await scheduler.pollDueJobs();

      // UPDATE to set status=running
      const [updateSql, updateParams] = pool.query.mock.calls[1] as [string, unknown[]];
      expect(updateSql).toContain('status');
      expect(updateParams).toContain('running');
      expect(updateParams).toContain('job-1');

      // Two bus publishes: schedule.fired + agent.task
      expect(bus.publish).toHaveBeenCalledTimes(2);

      const [layer1, event1] = bus.publish.mock.calls[0] as [string, { type: string }];
      expect(layer1).toBe('system');
      expect(event1.type).toBe('schedule.fired');

      const [layer2, event2] = bus.publish.mock.calls[1] as [string, { type: string; payload: Record<string, unknown> }];
      expect(layer2).toBe('system');
      expect(event2.type).toBe('agent.task');
      expect(event2.payload.channelId).toBe('scheduler');
      expect(event2.payload.senderId).toBe('scheduler');
      expect(event2.payload.conversationId).toBe('scheduler:job-1');
    });

    it('injects persistent task context when agent_task is linked', async () => {
      const row = fakeDbRow({
        agent_task_id: 'task-aaa',
        intent_anchor: 'weekly-report',
        progress: { step: 3 },
      });
      // SELECT due jobs
      pool.query.mockResolvedValueOnce({ rows: [row] });
      // UPDATE status to running
      pool.query.mockResolvedValueOnce({ rows: [] });

      await scheduler.pollDueJobs();

      // The agent.task event content should include intent_anchor + progress
      const [, taskEvent] = bus.publish.mock.calls[1] as [string, { payload: { content: string } }];
      const content = JSON.parse(taskEvent.payload.content);
      expect(content.intent_anchor).toBe('weekly-report');
      expect(content.progress).toEqual({ step: 3 });
      expect(content.task_payload).toEqual({ skill: 'morning-brief' });
    });

    it('logs and swallows errors during polling', async () => {
      pool.query.mockRejectedValueOnce(new Error('db down'));

      await scheduler.pollDueJobs();

      // Should not throw; should log the error
      expect(logger.error).toHaveBeenCalled();
    });

    it('sets run_started_at when claiming a job', async () => {
      const row = fakeDbRow();
      pool.query.mockResolvedValueOnce({ rows: [row] });       // SELECT due jobs
      pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // UPDATE claim

      await scheduler.pollDueJobs();

      const [claimSql, claimParams] = pool.query.mock.calls[1] as [string, unknown[]];
      expect(claimSql).toContain('run_started_at');
      expect(claimSql).toContain('now()');
      expect(claimParams).toContain('job-1');
    });
  });

  // -- completion tracking --

  describe('handleCompletion (via bus subscribers)', () => {
    it('completes a job run on agent.response', async () => {
      // Set up: fire a job first so the pendingJobs map has an entry
      const row = fakeDbRow();
      pool.query.mockResolvedValueOnce({ rows: [row] });
      pool.query.mockResolvedValueOnce({ rows: [] });

      await scheduler.pollDueJobs();

      // Get the task event ID that was published
      const [, taskEvent] = bus.publish.mock.calls[1] as [string, { id: string }];
      const taskEventId = taskEvent.id;

      // Set up completeJobRun to return success (not suspended)
      schedulerService.completeJobRun.mockResolvedValueOnce({ suspended: false });

      // Now start the scheduler to register the subscribers
      scheduler.start();

      // Simulate the agent.response handler being called
      // The subscribe mock captured the handler — call it directly
      const responseHandler = bus.subscribe.mock.calls[0]?.[2] as (event: unknown) => Promise<void>;
      await responseHandler({
        id: 'resp-1',
        type: 'agent.response',
        sourceLayer: 'agent',
        parentEventId: taskEventId,
        timestamp: new Date(),
        payload: { agentId: 'agent-1', conversationId: 'c1', content: 'done' },
      });

      expect(schedulerService.completeJobRun).toHaveBeenCalledWith('job-1', true, undefined);
    });

    it('completes a job run on agent.error', async () => {
      // Set up: fire a job
      const row = fakeDbRow();
      pool.query.mockResolvedValueOnce({ rows: [row] });
      pool.query.mockResolvedValueOnce({ rows: [] });

      await scheduler.pollDueJobs();

      const [, taskEvent] = bus.publish.mock.calls[1] as [string, { id: string }];
      const taskEventId = taskEvent.id;

      schedulerService.completeJobRun.mockResolvedValueOnce({ suspended: false });

      scheduler.start();

      // The error handler is the second subscriber
      const errorHandler = bus.subscribe.mock.calls[1]?.[2] as (event: unknown) => Promise<void>;
      await errorHandler({
        id: 'err-1',
        type: 'agent.error',
        sourceLayer: 'agent',
        parentEventId: taskEventId,
        timestamp: new Date(),
        payload: {
          agentId: 'agent-1',
          conversationId: 'c1',
          errorType: 'budget_exceeded',
          source: 'runtime',
          message: 'budget blown',
          retryable: false,
          context: {},
        },
      });

      expect(schedulerService.completeJobRun).toHaveBeenCalledWith('job-1', false, 'budget blown');
    });

    it('ignores events not originating from the scheduler', async () => {
      scheduler.start();

      const responseHandler = bus.subscribe.mock.calls[0]?.[2] as (event: unknown) => Promise<void>;
      await responseHandler({
        id: 'resp-x',
        type: 'agent.response',
        sourceLayer: 'agent',
        parentEventId: 'unrelated-event-id',
        timestamp: new Date(),
        payload: { agentId: 'a1', conversationId: 'c1', content: 'hi' },
      });

      // completeJobRun should NOT have been called
      expect(schedulerService.completeJobRun).not.toHaveBeenCalled();
    });
  });

  // -- loadDeclarativeJobs --

  describe('loadDeclarativeJobs', () => {
    it('upserts jobs for configs with a schedule block', async () => {
      schedulerService.upsertDeclarativeJob.mockResolvedValue('job-decl-1');

      const configs: AgentYamlConfig[] = [
        {
          name: 'coordinator',
          model: { provider: 'anthropic', model: 'claude-3' },
          system_prompt: 'You are the coordinator.',
          schedule: [
            { cron: '0 9 * * 1', task: 'weekly-standup' },
            { cron: '0 8 * * *', task: 'daily-brief' },
          ],
        },
        {
          name: 'researcher',
          model: { provider: 'anthropic', model: 'claude-3' },
          system_prompt: 'You research things.',
          // No schedule block — should be skipped.
        },
      ];

      await scheduler.loadDeclarativeJobs(configs);

      // Only the coordinator's 2 schedules should be upserted
      expect(schedulerService.upsertDeclarativeJob).toHaveBeenCalledTimes(2);
      expect(schedulerService.upsertDeclarativeJob).toHaveBeenCalledWith(
        'coordinator',
        { cron: '0 9 * * 1', task: 'weekly-standup' },
      );
      expect(schedulerService.upsertDeclarativeJob).toHaveBeenCalledWith(
        'coordinator',
        { cron: '0 8 * * *', task: 'daily-brief' },
      );
    });

    it('skips configs without a schedule block', async () => {
      const configs: AgentYamlConfig[] = [
        {
          name: 'no-schedule',
          model: { provider: 'anthropic', model: 'claude-3' },
          system_prompt: 'No schedule.',
        },
      ];

      await scheduler.loadDeclarativeJobs(configs);

      expect(schedulerService.upsertDeclarativeJob).not.toHaveBeenCalled();
    });

    it('skips configs with an empty schedule array', async () => {
      const configs: AgentYamlConfig[] = [
        {
          name: 'empty-sched',
          model: { provider: 'anthropic', model: 'claude-3' },
          system_prompt: 'Empty schedule.',
          schedule: [],
        },
      ];

      await scheduler.loadDeclarativeJobs(configs);

      expect(schedulerService.upsertDeclarativeJob).not.toHaveBeenCalled();
    });

    it('logs and continues on upsert failure', async () => {
      schedulerService.upsertDeclarativeJob
        .mockRejectedValueOnce(new Error('db error'))
        .mockResolvedValueOnce('job-ok');

      const configs: AgentYamlConfig[] = [
        {
          name: 'agent-x',
          model: { provider: 'anthropic', model: 'claude-3' },
          system_prompt: 'test',
          schedule: [
            { cron: '0 1 * * *', task: 'fail-task' },
            { cron: '0 2 * * *', task: 'ok-task' },
          ],
        },
      ];

      await scheduler.loadDeclarativeJobs(configs);

      // Both were attempted
      expect(schedulerService.upsertDeclarativeJob).toHaveBeenCalledTimes(2);
      // Error was logged for the first one
      expect(logger.error).toHaveBeenCalled();
      // Second one succeeded
      expect(logger.info).toHaveBeenCalled();
    });
  });
});
