// resumable-continuation.test.ts — pause → continuation → resume integration (#1175).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { EventBus } from '../../src/bus/bus.js';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { Scheduler } from '../../src/scheduler/scheduler.js';
import { SchedulerService } from '../../src/scheduler/scheduler-service.js';
import { TaskRepo } from '../../src/db/task-repo.js';
import { ResumableContinuationSubscriber } from '../../src/agents/resumable-continuation-subscriber.js';
import { RESUMABLE_CONTINUATION_CREATED_BY } from '../../src/agents/resumable-continuation.js';
import { createAgentResponse } from '../../src/bus/events.js';
import type { LLMProvider, Message } from '../../src/agents/llm/provider.js';
import type { EventBus as EventBusType } from '../../src/bus/bus.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'ResumableContinuation Test';
const logger = pino({ level: 'silent' });
const noopBus = { publish: async () => {}, subscribe: () => {} } as unknown as EventBusType;

const MOCK_PROVENANCE = {
  requestedModel: 'mock-model',
  actualModel: 'mock-model',
  providerRequestId: 'msg_mock_000',
} as const;

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query(
    `DELETE FROM scheduled_jobs WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`,
    [`${PREFIX}%`],
  );
  await pool.query(`DELETE FROM tasks WHERE title LIKE $1`, [`${PREFIX}%`]);
}

describeIf('Resumable continuation scheduling (#1175)', () => {
  let pool: pg.Pool;
  let repo: TaskRepo;
  let schedulerService: SchedulerService;
  let bus: EventBus;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    repo = new TaskRepo(pool, noopBus, logger as never, 'UTC');
    bus = new EventBus(logger as never);
    schedulerService = new SchedulerService(pool, bus, logger as never, 'UTC');
  });

  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
  });

  beforeEach(async () => {
    await cleanup(pool);
  });

  it('pause → continuation scheduled → resumes from checkpoint → makes forward progress', async () => {
    const task = await repo.createTask({
      agentId: 'social-media',
      title: `${PREFIX} audit`,
      source: 'coordinator',
      sourceAgentId: 'social-media',
      resumable: true,
      tags: ['resumable'],
    });
    await repo.setResumableBlock(task.id, {
      cursor: 'page:3',
      done: 25,
      total: 1300,
      accumulator: ['did:plc:abc'],
      lastSliceUnits: 25,
      next: 'Review page 4',
    }, 'social-media');
    await repo.updateTask(task.id, { status: 'in_progress' }, 'social-media');

    const subscriber = new ResumableContinuationSubscriber({
      pool,
      bus,
      logger: logger as never,
      schedulerService,
      eligibleAgents: new Set(['social-media', 'coordinator']),
      continuationDelaySeconds: 1,
    });
    subscriber.start();

    await bus.publish('agent', createAgentResponse({
      agentId: 'social-media',
      conversationId: 'conv-pause',
      content: JSON.stringify({
        _curia_protocol: 'execution_paused',
        task_id: task.id,
        done: 25,
        total: 1300,
        cursor: 'page:3',
        last_slice_units: 25,
        next: 'Review page 4',
      }),
      parentEventId: 'parent-pause',
    }));

    const { rows: wakeRows } = await pool.query(
      `SELECT id, agent_id, created_by, status, next_run_at, task_id
         FROM scheduled_jobs
        WHERE task_id = $1`,
      [task.id],
    );
    expect(wakeRows).toHaveLength(1);
    const wake = wakeRows[0] as {
      id: string;
      agent_id: string;
      created_by: string;
      status: string;
      task_id: string;
    };
    expect(wake.agent_id).toBe('social-media');
    expect(wake.created_by).toBe(RESUMABLE_CONTINUATION_CREATED_BY);
    expect(wake.status).toBe('pending');

    // Duplicate pause must not enqueue a second continuation.
    await bus.publish('agent', createAgentResponse({
      agentId: 'social-media',
      conversationId: 'conv-pause-2',
      content: JSON.stringify({
        _curia_protocol: 'execution_paused',
        task_id: task.id,
        done: 25,
        total: 1300,
        cursor: 'page:3',
        last_slice_units: 25,
        next: 'Review page 4',
      }),
      parentEventId: 'parent-pause-2',
    }));
    const { rows: afterDup } = await pool.query(
      `SELECT id FROM scheduled_jobs WHERE task_id = $1`,
      [task.id],
    );
    expect(afterDup).toHaveLength(1);

    // Fire the continuation immediately and verify the specialist receives checkpoint context.
    await pool.query(
      `UPDATE scheduled_jobs SET next_run_at = now() - interval '1 second' WHERE id = $1`,
      [wake.id],
    );

    const agentTaskEvents: Array<{
      agentId: string;
      content: string;
      metadata?: Record<string, unknown>;
    }> = [];
    bus.subscribe('agent.task', 'system', (event) => {
      const e = event as { payload: { agentId: string; content: string; metadata?: Record<string, unknown> } };
      agentTaskEvents.push({
        agentId: e.payload.agentId,
        content: e.payload.content,
        metadata: e.payload.metadata,
      });
    });

    let capturedSystemPrompt = '';
    const specialistLlm: LLMProvider = {
      id: 'mock-specialist',
      chat: vi.fn().mockImplementation(async (params: { messages: Message[] }) => {
        const system = params.messages.find((m: Message) => m.role === 'system');
        capturedSystemPrompt = typeof system?.content === 'string' ? system.content : '';
        return {
          type: 'text' as const,
          content: 'Slice advanced.',
          usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          provenance: MOCK_PROVENANCE,
        };
      }),
    };

    const specialist = new AgentRuntime({
      agentId: 'social-media',
      systemPrompt: 'You process social audits.',
      provider: specialistLlm,
      bus,
      logger: logger as never,
      errorBudget: { maxTurns: 10, maxConsecutiveErrors: 5 },
    });
    specialist.register();

    const scheduler = new Scheduler({
      pool,
      bus,
      logger: logger as never,
      schedulerService,
    });
    scheduler.start();
    try {
      await scheduler.pollDueJobs();

      await vi.waitFor(() => {
        expect(agentTaskEvents.length).toBeGreaterThan(0);
        expect(specialistLlm.chat).toHaveBeenCalled();
      });

      expect(agentTaskEvents[0]!.agentId).toBe('social-media');
      const boundTask = (agentTaskEvents[0]!.metadata?.boundTask ?? {}) as {
        progress?: { resumable?: { done?: number; total?: number } };
      };
      expect(boundTask.progress?.resumable?.done).toBe(25);
      expect(boundTask.progress?.resumable?.total).toBe(1300);
      expect(capturedSystemPrompt).toContain('## Last Checkpoint (resume from here)');
      expect(capturedSystemPrompt).toContain('25 / 1300');

      const advanced = await repo.setResumableBlock(task.id, {
        cursor: 'page:4',
        done: 50,
        total: 1300,
        accumulator: ['did:plc:abc', 'did:plc:def'],
        lastSliceUnits: 25,
        next: 'Review page 5',
      }, 'social-media');
      expect('task' in advanced).toBe(true);
      const block = await repo.getResumableBlock(task.id);
      expect(block?.done).toBe(50);
      expect(block?.cursor).toBe('page:4');
    } finally {
      scheduler.stop();
    }
  });
});
