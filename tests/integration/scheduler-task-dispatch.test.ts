/**
 * Integration test: scheduler task-bound dispatch routing (Tasks v1, issue 4).
 *
 * Uses a real EventBus and real AgentRuntime instances (mock LLM, mock pool) to verify
 * that task-wake fires reach the correct specialist agent and carry the expected context.
 * No Postgres required — the pool is mocked to return pre-built job rows.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../src/bus/bus.js';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { Scheduler } from '../../src/scheduler/scheduler.js';
import type { LLMProvider } from '../../src/agents/llm/provider.js';
import { createLogger } from '../../src/logger.js';

const MOCK_PROVENANCE = {
  requestedModel: 'mock-model',
  actualModel: 'mock-model',
  providerRequestId: 'msg_mock_000',
} as const;

function mockSchedulerService() {
  return {
    completeJobRun: vi.fn().mockResolvedValue({ suspended: false }),
    upsertDeclarativeJob: vi.fn(),
    cancelStaleDeclarativeJobs: vi.fn(),
    getJob: vi.fn(),
    nextRunFromCron: vi.fn(),
    recoverStuckJob: vi.fn(),
    pauseJobForDrift: vi.fn(),
  };
}

/** Build a fake task-wake scheduled_jobs row joined with the linked tasks columns. */
function fakeTaskWakeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-task-wake-1',
    agent_id: 'meeting-debrief',
    cron_expr: null,
    run_at: new Date().toISOString(),
    task_payload: { type: 'task-wake' },
    status: 'pending',
    last_run_at: null,
    next_run_at: new Date().toISOString(),
    last_error: null,
    consecutive_failures: 0,
    created_by: 'task-create',
    created_at: new Date().toISOString(),
    timezone: 'UTC',
    agent_task_id: 'task-abc-123',
    intent_anchor: 'Follow up with board on Q3 results',
    progress: { notes: [{ at: '2026-06-01T10:00:00Z', note: 'Initial debrief complete' }] },
    task_title: 'Board Q3 follow-up',
    run_started_at: null,
    expected_duration_seconds: null,
    last_run_outcome: null,
    last_run_summary: null,
    last_run_context: null,
    originator: null,
    ...overrides,
  };
}

describe('Scheduler task-bound dispatch integration', () => {
  it('delivers task-wake fire to the specialist agent with task context in content', async () => {
    const logger = createLogger('silent');
    const bus = new EventBus(logger);
    const schedulerService = mockSchedulerService();

    // Capture every agent.task event published to the bus.
    const agentTaskEvents: Array<{ agentId: string; content: string; intentAnchor?: string }> = [];
    bus.subscribe('agent.task', 'system', (event) => {
      const e = event as { payload: { agentId: string; content: string; intentAnchor?: string } };
      agentTaskEvents.push({
        agentId: e.payload.agentId,
        content: e.payload.content,
        intentAnchor: e.payload.intentAnchor,
      });
    });

    // Register the specialist agent ('meeting-debrief') with a mock LLM.
    const specialistLlm: LLMProvider = {
      id: 'mock-specialist',
      chat: vi.fn().mockResolvedValue({
        type: 'text' as const,
        content: 'Debrief task advanced.',
        usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        provenance: MOCK_PROVENANCE,
      }),
    };
    const specialist = new AgentRuntime({
      agentId: 'meeting-debrief',
      systemPrompt: 'You process meeting debriefs.',
      provider: specialistLlm,
      bus,
      logger,
    });
    specialist.register();

    // Register coordinator as a canary — it must NOT receive this fire.
    const coordinatorLlm: LLMProvider = {
      id: 'mock-coordinator',
      chat: vi.fn(),
    };
    const coordinator = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are the coordinator.',
      provider: coordinatorLlm,
      bus,
      logger,
    });
    coordinator.register();

    // Mock pool: returns one task-wake job (agent_id = 'meeting-debrief').
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [fakeTaskWakeRow()] })  // SELECT due jobs
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }),     // UPDATE claim
    };

    const scheduler = new Scheduler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool: pool as any,
      bus,
      logger,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      schedulerService: schedulerService as any,
    });

    scheduler.start();
    await scheduler.pollDueJobs();

    // Wait for the agent.response to propagate back through handleCompletion.
    await vi.waitFor(() => {
      expect(schedulerService.completeJobRun).toHaveBeenCalled();
    });

    scheduler.stop();

    // The agent.task must target 'meeting-debrief', not 'coordinator'.
    expect(agentTaskEvents).toHaveLength(1);
    expect(agentTaskEvents[0]!.agentId).toBe('meeting-debrief');

    // Content bundle must carry task_id, title, and progress.
    const content = JSON.parse(agentTaskEvents[0]!.content) as Record<string, unknown>;
    expect(content.task_id).toBe('task-abc-123');
    expect(content.title).toBe('Board Q3 follow-up');
    expect(content.progress).toEqual({ notes: [{ at: '2026-06-01T10:00:00Z', note: 'Initial debrief complete' }] });

    // intent_anchor travels in the event payload, not in content.
    expect(agentTaskEvents[0]!.intentAnchor).toBe('Follow up with board on Q3 results');
    expect(content.intent_anchor).toBeUndefined();

    // Specialist LLM was called; coordinator LLM was not.
    expect(specialistLlm.chat).toHaveBeenCalledOnce();
    expect(coordinatorLlm.chat).not.toHaveBeenCalled();
  });

  it('falls back to coordinator when agent_id is coordinator (CEO-created task with no specialist)', async () => {
    const logger = createLogger('silent');
    const bus = new EventBus(logger);
    const schedulerService = mockSchedulerService();

    const agentTaskEvents: Array<{ agentId: string }> = [];
    bus.subscribe('agent.task', 'system', (event) => {
      const e = event as { payload: { agentId: string } };
      agentTaskEvents.push({ agentId: e.payload.agentId });
    });

    const coordinatorLlm: LLMProvider = {
      id: 'mock-coordinator',
      chat: vi.fn().mockResolvedValue({
        type: 'text' as const,
        content: 'Handled by coordinator.',
        usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        provenance: MOCK_PROVENANCE,
      }),
    };
    const coordinator = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are the coordinator.',
      provider: coordinatorLlm,
      bus,
      logger,
    });
    coordinator.register();

    // CEO-created task: task-create called by coordinator → agent_id = 'coordinator',
    // source_agent_id = null, so scheduled_jobs.agent_id = 'coordinator'.
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [fakeTaskWakeRow({
            id: 'job-ceo-task',
            agent_id: 'coordinator',
            agent_task_id: 'task-ceo-456',
            task_title: 'Call Steve re: partnership',
          })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }),
    };

    const scheduler = new Scheduler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool: pool as any,
      bus,
      logger,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      schedulerService: schedulerService as any,
    });

    scheduler.start();
    await scheduler.pollDueJobs();

    await vi.waitFor(() => {
      expect(schedulerService.completeJobRun).toHaveBeenCalled();
    });

    scheduler.stop();

    expect(agentTaskEvents).toHaveLength(1);
    expect(agentTaskEvents[0]!.agentId).toBe('coordinator');
    expect(coordinatorLlm.chat).toHaveBeenCalledOnce();
  });

  it('non-task-bound jobs fire without task context in content', async () => {
    const logger = createLogger('silent');
    const bus = new EventBus(logger);
    const schedulerService = mockSchedulerService();

    const agentTaskEvents: Array<{ agentId: string; content: string }> = [];
    bus.subscribe('agent.task', 'system', (event) => {
      const e = event as { payload: { agentId: string; content: string } };
      agentTaskEvents.push({ agentId: e.payload.agentId, content: e.payload.content });
    });

    const coordinatorLlm: LLMProvider = {
      id: 'mock-coordinator',
      chat: vi.fn().mockResolvedValue({
        type: 'text' as const,
        content: 'Morning brief delivered.',
        usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        provenance: MOCK_PROVENANCE,
      }),
    };
    new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are the coordinator.',
      provider: coordinatorLlm,
      bus,
      logger,
    }).register();

    // Standard cron job: no task_id link.
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [{
            id: 'job-cron-1',
            agent_id: 'coordinator',
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
            task_title: null,
            run_started_at: null,
            expected_duration_seconds: null,
            last_run_outcome: null,
            last_run_summary: null,
            last_run_context: null,
            originator: null,
          }],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }),
    };

    const scheduler = new Scheduler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool: pool as any,
      bus,
      logger,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      schedulerService: schedulerService as any,
    });

    scheduler.start();
    await scheduler.pollDueJobs();

    await vi.waitFor(() => {
      expect(schedulerService.completeJobRun).toHaveBeenCalled();
    });

    scheduler.stop();

    expect(agentTaskEvents).toHaveLength(1);
    expect(agentTaskEvents[0]!.agentId).toBe('coordinator');

    const content = JSON.parse(agentTaskEvents[0]!.content) as Record<string, unknown>;
    // Non-task-bound: raw payload with no task_id injected.
    expect(content.skill).toBe('morning-brief');
    expect(content.task_id).toBeUndefined();
  });
});
