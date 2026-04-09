import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler, POLL_INTERVAL_MS, WATCHDOG_INTERVAL_MS, computeRecoveryTimeout } from '../../../src/scheduler/scheduler.js';
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
    recoverStuckJob: vi.fn(),
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
    timezone: 'UTC',
    agent_task_id: null,
    intent_anchor: null,
    progress: null,
    run_started_at: null,
    expected_duration_seconds: null,
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

    it('starts a watchdog interval that calls recoverStuckJobs', async () => {
      pool.query.mockResolvedValue({ rows: [] }); // for both pollDueJobs and recoverStuckJobs

      // Spy on recoverStuckJobs
      const recoverSpy = vi.spyOn(scheduler, 'recoverStuckJobs').mockResolvedValue();

      scheduler.start();

      // Advance by one watchdog interval
      await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS);

      expect(recoverSpy).toHaveBeenCalled();
    });

    it('stop clears the watchdog interval', async () => {
      pool.query.mockResolvedValue({ rows: [] });

      const recoverSpy = vi.spyOn(scheduler, 'recoverStuckJobs').mockResolvedValue();

      scheduler.start();
      scheduler.stop();

      recoverSpy.mockClear();

      await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS * 3);

      expect(recoverSpy).not.toHaveBeenCalled();
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

    it('uses agent_id from schedule entry when present', async () => {
      schedulerService.upsertDeclarativeJob.mockResolvedValue('job-decl-1');

      const configs: AgentYamlConfig[] = [
        {
          name: 'writing-scout',
          model: { provider: 'anthropic', model: 'claude-3' },
          system_prompt: 'Scout.',
          schedule: [
            { cron: '30 8 * * 2', task: 'Run the writing scout', agent_id: 'coordinator' },
          ],
        },
        // coordinator must be in the config list so the unknown-agent guard allows the target
        {
          name: 'coordinator',
          model: { provider: 'anthropic', model: 'claude-3' },
          system_prompt: 'Coord.',
        },
      ];

      await scheduler.loadDeclarativeJobs(configs);

      // Should be called with 'coordinator', not 'writing-scout'
      expect(schedulerService.upsertDeclarativeJob).toHaveBeenCalledWith(
        'coordinator',
        { cron: '30 8 * * 2', task: 'Run the writing scout', agent_id: 'coordinator' },
      );
    });

    it('defaults to config.name when agent_id is omitted', async () => {
      schedulerService.upsertDeclarativeJob.mockResolvedValue('job-decl-2');

      const configs: AgentYamlConfig[] = [
        {
          name: 'my-agent',
          model: { provider: 'anthropic', model: 'claude-3' },
          system_prompt: 'Agent.',
          schedule: [
            { cron: '0 9 * * 1', task: 'weekly task' },
          ],
        },
      ];

      await scheduler.loadDeclarativeJobs(configs);

      expect(schedulerService.upsertDeclarativeJob).toHaveBeenCalledWith(
        'my-agent',
        { cron: '0 9 * * 1', task: 'weekly task' },
      );
    });

    it('warns when two agents form a targeting cycle', async () => {
      schedulerService.upsertDeclarativeJob.mockResolvedValue('job-1');

      const configs: AgentYamlConfig[] = [
        {
          name: 'agent-a',
          model: { provider: 'anthropic', model: 'claude-3' },
          system_prompt: 'A.',
          schedule: [{ cron: '0 9 * * 1', task: 'task', agent_id: 'agent-b' }],
        },
        {
          name: 'agent-b',
          model: { provider: 'anthropic', model: 'claude-3' },
          system_prompt: 'B.',
          schedule: [{ cron: '0 9 * * 1', task: 'task', agent_id: 'agent-a' }],
        },
      ];

      await scheduler.loadDeclarativeJobs(configs);

      // Exactly one warning per cycle pair (deduped by lexicographic ordering)
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ agentA: 'agent-a', agentB: 'agent-b' }),
        expect.stringContaining('cycle'),
      );
    });

    it('does not warn when agent targets itself (self-targeting is fine)', async () => {
      schedulerService.upsertDeclarativeJob.mockResolvedValue('job-1');

      const configs: AgentYamlConfig[] = [
        {
          name: 'coordinator',
          model: { provider: 'anthropic', model: 'claude-3' },
          system_prompt: 'Coord.',
          schedule: [{ cron: '0 9 * * 1', task: 'task', agent_id: 'coordinator' }],
        },
      ];

      await scheduler.loadDeclarativeJobs(configs);

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('skips and logs error when agent_id targets an unknown agent', async () => {
      const configs: AgentYamlConfig[] = [
        {
          name: 'my-agent',
          model: { provider: 'anthropic', model: 'claude-3' },
          system_prompt: 'Agent.',
          schedule: [
            { cron: '0 9 * * 1', task: 'weekly task', agent_id: 'nonexistent-agent' },
          ],
        },
      ];

      await scheduler.loadDeclarativeJobs(configs);

      // Should not attempt to upsert — unknown target is rejected before the try block
      expect(schedulerService.upsertDeclarativeJob).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ sourceAgent: 'my-agent', targetAgentId: 'nonexistent-agent' }),
        expect.stringContaining('not a known agent'),
      );
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

  // -- recoverStuckJobs --

  describe('recoverStuckJobs', () => {
    it('does nothing when no jobs are stuck', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await scheduler.recoverStuckJobs();

      expect(pool.query).toHaveBeenCalledOnce();
      expect(schedulerService.recoverStuckJob).not.toHaveBeenCalled();
      expect(bus.publish).not.toHaveBeenCalled();
    });

    it('recovers a stuck job: calls recoverStuckJob, publishes schedule.recovered', async () => {
      const stuckRow = {
        id: 'job-stuck',
        agent_id: 'agent-1',
        run_started_at: new Date(Date.now() - 3600_000).toISOString(),
        timeout_seconds: 900,
      };
      pool.query.mockResolvedValueOnce({ rows: [stuckRow] });
      schedulerService.recoverStuckJob.mockResolvedValueOnce({
        noOp: false,
        suspended: false,
        consecutiveFailures: 1,
      });

      await scheduler.recoverStuckJobs();

      expect(schedulerService.recoverStuckJob).toHaveBeenCalledWith('job-stuck', 900);

      expect(bus.publish).toHaveBeenCalledOnce();
      const [layer, event] = bus.publish.mock.calls[0] as [string, { type: string }];
      expect(layer).toBe('system');
      expect(event.type).toBe('schedule.recovered');
    });

    it('publishes schedule.recovered with suspended:true when job is suspended', async () => {
      const stuckRow = {
        id: 'job-3fail',
        agent_id: 'agent-1',
        run_started_at: new Date(Date.now() - 7200_000).toISOString(),
        timeout_seconds: 600,
      };
      pool.query.mockResolvedValueOnce({ rows: [stuckRow] });
      schedulerService.recoverStuckJob.mockResolvedValueOnce({
        noOp: false,
        suspended: true,
        consecutiveFailures: 3,
      });

      await scheduler.recoverStuckJobs();

      expect(bus.publish).toHaveBeenCalledOnce();
      const [, event] = bus.publish.mock.calls[0] as [string, { type: string; payload: { suspended: boolean } }];
      expect(event.type).toBe('schedule.recovered');
      expect(event.payload.suspended).toBe(true);
    });

    it('skips publish and warn log when recoverStuckJob returns noOp:true (race condition)', async () => {
      const stuckRow = {
        id: 'job-race',
        agent_id: 'agent-1',
        run_started_at: new Date(Date.now() - 3600_000).toISOString(),
        timeout_seconds: 900,
      };
      pool.query.mockResolvedValueOnce({ rows: [stuckRow] });
      schedulerService.recoverStuckJob.mockResolvedValueOnce({
        noOp: true,
        suspended: false,
        consecutiveFailures: 0,
      });

      await scheduler.recoverStuckJobs();

      // No bus publish and no warn log — the job completed cleanly before recovery ran
      expect(bus.publish).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'job-race' }),
        'Stuck job recovered',
      );
    });

    it('continues recovering other jobs if one recovery fails', async () => {
      const rows = [
        { id: 'job-a', agent_id: 'agent-1', run_started_at: new Date().toISOString(), timeout_seconds: 600 },
        { id: 'job-b', agent_id: 'agent-2', run_started_at: new Date().toISOString(), timeout_seconds: 600 },
      ];
      pool.query.mockResolvedValueOnce({ rows });
      schedulerService.recoverStuckJob
        .mockRejectedValueOnce(new Error('db error on job-a'))
        .mockResolvedValueOnce({ noOp: false, suspended: false, consecutiveFailures: 1 });

      await scheduler.recoverStuckJobs();

      expect(schedulerService.recoverStuckJob).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledOnce();
    });
  });
});

describe('computeRecoveryTimeout', () => {
  it('gives 7.5× timeout for short jobs', () => {
    expect(computeRecoveryTimeout(60)).toBe(450);    // 1m → 7.5m
    expect(computeRecoveryTimeout(120)).toBe(900);   // 2m → 15m
  });

  it('caps the extension at +60 minutes for long jobs', () => {
    expect(computeRecoveryTimeout(1800)).toBe(5400);  // 30m → 90m (min(13500, 5400) = 5400)
    expect(computeRecoveryTimeout(3600)).toBe(7200);  // 60m → 120m (min(27000, 7200) = 7200)
    expect(computeRecoveryTimeout(7200)).toBe(10800); // 120m → 180m (min(54000, 10800) = 10800)
  });

  it('switches from multiplier to cap at the crossover point', () => {
    // At 800s: 800 * 7.5 = 6000, 800 + 3600 = 4400. min = 4400 (cap wins)
    expect(computeRecoveryTimeout(800)).toBe(4400);
    // At 600s: 600 * 7.5 = 4500, 600 + 3600 = 4200. min = 4200 (cap wins)
    expect(computeRecoveryTimeout(600)).toBe(4200);
    // At 480s: 480 * 7.5 = 3600, 480 + 3600 = 4080. min = 3600 (multiplier wins)
    expect(computeRecoveryTimeout(480)).toBe(3600);
  });
});
