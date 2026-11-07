// specialist-decline-follow-up.test.ts — a decline in a run nobody reads is not dropped (#2496).
//
// A scheduled run or a task wake ends with a reply that never reaches the principal, so a
// specialist decline in it used to vanish: the work (time-sensitive outreach, in prod) just
// did not happen. This drives the real runtime with a scripted model and a declining
// specialist, against the real task handlers and Postgres, and checks the durable record:
// a Curia-owned follow-up task for a scheduled run, whose job keeps the decline in
// last_run_context, and a note on the woken task for a task wake. It also checks the
// handoff rule end to end: the follow-up reaches the principal only with a question.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { EventBus } from '../../src/bus/bus.js';
import { createAgentTask, type AgentResponseEvent } from '../../src/bus/events.js';
import { AgentRuntime } from '../../src/agents/runtime.js';
import type { LLMProvider, ToolDefinition } from '../../src/agents/llm/provider.js';
import type { ExecutionLayer } from '../../src/skills/execution.js';
import type { ToolContext, ToolResult } from '../../src/skills/types.js';
import { TaskRepo } from '../../src/db/task-repo.js';
import { SchedulerService } from '../../src/scheduler/scheduler-service.js';
import { TaskCreateHandler } from '../../skills/tasks/tools/task-create/handler.js';
import { TaskUpdateHandler } from '../../skills/tasks/tools/task-update/handler.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'Decline2496 Test';
const CREATED_BY = 'test-2496';
const logger = pino({ level: 'silent' });
const DECLINE_MESSAGE = 'dana@example.test is not in the mailbox or a contact, so I cannot draft to it.';

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query(`DELETE FROM scheduled_jobs WHERE created_by = $1`, [CREATED_BY]);
  await pool.query(
    `DELETE FROM tasks WHERE title LIKE $1 OR description LIKE $1`,
    [`%${PREFIX}%`],
  );
}

const usage = { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const provenance = { requestedModel: 'mock-model', actualModel: 'mock-model', providerRequestId: 'msg_mock' };
const toolDef = (name: string): ToolDefinition => ({
  name,
  description: name,
  input_schema: { type: 'object' as const, properties: {}, required: [] as string[] },
});

describeIf('Specialist decline in a background run leaves a durable record (#2496)', () => {
  let pool: pg.Pool;
  let repo: TaskRepo;
  // Cleanup deletes rows, so it runs only once the guard has confirmed curia_test: afterAll
  // still runs after a failed beforeAll.
  let onTestDb = false;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    onTestDb = true;
  });

  afterAll(async () => {
    if (onTestDb) await cleanup(pool);
    await pool.end();
  });

  beforeEach(async () => {
    await cleanup(pool);
    repo = new TaskRepo(pool, new EventBus(logger as never), logger as never, 'UTC');
  });

  /** An execution layer whose delegate declines and whose task tools are the real handlers. */
  function executionLayer(): ExecutionLayer {
    const ctxFor = (input: Record<string, unknown>): ToolContext => ({
      input,
      secret: () => 'unused',
      log: logger,
      agentId: 'coordinator',
      timezone: 'UTC',
      taskRepo: repo,
    } as unknown as ToolContext);
    return {
      invoke: async (tool: string, input: Record<string, unknown>): Promise<ToolResult> => {
        if (tool === 'delegate') {
          return {
            success: true,
            data: {
              agent: 'ceo-inbox',
              declined: true,
              failed: true,
              reason: 'specialist_decline',
              retryable: false,
              message: DECLINE_MESSAGE,
            },
          };
        }
        if (tool === 'task-create') return new TaskCreateHandler().execute(ctxFor(input));
        if (tool === 'task-update') return new TaskUpdateHandler().execute(ctxFor(input));
        return { success: true, data: {} };
      },
      getToolDefinitions: () => [],
    } as unknown as ExecutionLayer;
  }

  /** Run one coordinator turn on the scheduler channel: delegate, decline, then a reply. */
  async function runScheduledTurn(content: string, metadata?: Record<string, unknown>): Promise<AgentResponseEvent> {
    const bus = new EventBus(logger as never);
    const replies = [
      {
        type: 'tool_use' as const,
        toolCalls: [{ id: 'call-1', name: 'delegate', input: { agent: 'ceo-inbox', task: `${PREFIX}: draft outreach to dana@example.test` } }],
        usage,
        provenance,
      },
      { type: 'text' as const, content: 'The outreach draft could not be saved.', usage, provenance },
    ];
    let call = 0;
    const provider = {
      id: 'mock',
      chat: async () => replies[Math.min(call++, replies.length - 1)]!,
    } as unknown as LLMProvider;
    const responses: AgentResponseEvent[] = [];
    bus.subscribe('agent.response', 'dispatch', (event) => {
      responses.push(event as AgentResponseEvent);
    });
    const agent = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are an assistant.',
      provider,
      resolvedModel: 'mock-model',
      bus,
      logger: logger as never,
      executionLayer: executionLayer(),
      pinnedTools: ['delegate'],
      skillToolDefs: [toolDef('delegate')],
    });
    agent.register();
    await bus.publish('dispatch', createAgentTask({
      agentId: 'coordinator',
      conversationId: `scheduler-2496-${Date.now()}`,
      channelId: 'scheduler',
      senderId: 'scheduler',
      content,
      ...(metadata && { metadata }),
      parentEventId: 'schedule-fired-2496',
    }));
    expect(responses).toHaveLength(1);
    return responses[0]!;
  }

  it('a scheduled run files a Curia-owned follow-up and its job keeps the decline', async () => {
    const svc = new SchedulerService(pool, new EventBus(logger as never), logger as never, 'UTC');
    const { jobId } = await svc.createJob({
      agentId: 'coordinator',
      cronExpr: '0 9 * * 1',
      taskPayload: { task: `${PREFIX}: weekly outreach` },
      createdBy: CREATED_BY,
    });
    await pool.query(`UPDATE scheduled_jobs SET status = 'running' WHERE id = $1`, [jobId]);

    const response = await runScheduledTurn(`${PREFIX}: run the weekly outreach.`);

    // The durable record: a follow-up owned by Curia, which the heartbeat wakes.
    const { rows } = await pool.query<{ owner: string; status: string; tags: string[]; description: string }>(
      `SELECT owner, status, tags, description FROM tasks WHERE description LIKE $1`,
      [`%${PREFIX}%`],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.owner).toBe('curia');
    expect(rows[0]!.status).toBe('open');
    expect(rows[0]!.tags).toEqual(expect.arrayContaining(['delegation-failure', 'specialist-decline', 'ceo-inbox']));
    expect(rows[0]!.description).toContain(DECLINE_MESSAGE);

    // The originating job: the scheduler completes the run with the response's failedSkills.
    await svc.completeJobRun(jobId, true, undefined, 'summary', response.payload.failedSkills);
    const job = await pool.query<{ last_run_context: { failedSkills?: Array<{ name: string; error: string }> } | null }>(
      `SELECT last_run_context FROM scheduled_jobs WHERE id = $1`,
      [jobId],
    );
    expect(job.rows[0]!.last_run_context?.failedSkills).toEqual([
      { name: 'delegate', error: expect.stringContaining('ceo-inbox declined') },
    ]);
  });

  it('a task wake records the decline on the woken task, not a new one', async () => {
    const woken = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} outreach to Dana`,
      source: 'coordinator',
      sourceAgentId: 'coordinator',
    });

    await runScheduledTurn(JSON.stringify({ task_id: woken.id }), {
      boundTask: { taskId: woken.id, progress: {} },
    });

    const reloaded = await repo.getTask(woken.id);
    const notes = (reloaded!.progress as { notes?: Array<{ note: string }> }).notes ?? [];
    expect(notes.at(-1)?.note).toContain('ceo-inbox declined delegated work in this run.');
    expect(notes.at(-1)?.note).toContain(DECLINE_MESSAGE);
    const followUps = await pool.query(
      `SELECT 1 FROM tasks WHERE tags @> ARRAY['specialist-decline']::text[] AND description LIKE $1`,
      [`%${PREFIX}%`],
    );
    expect(followUps.rows).toHaveLength(0);
  });

  it('the follow-up reaches the principal only with a question for them', async () => {
    await runScheduledTurn(`${PREFIX}: run the weekly outreach.`);
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM tasks WHERE tags @> ARRAY['specialist-decline']::text[] AND description LIKE $1`,
      [`%${PREFIX}%`],
    );
    const taskId = rows[0]!.id;
    const update = (input: Record<string, unknown>) => new TaskUpdateHandler().execute({
      input: { task_id: taskId, ...input },
      secret: () => 'unused',
      log: logger,
      agentId: 'coordinator',
      timezone: 'UTC',
      taskRepo: repo,
    } as unknown as ToolContext);

    const refused = await update({ owner: 'ceo', progress_note: 'Re-scope it smaller, or cancel.' });
    expect(refused.success).toBe(false);
    expect((await repo.getTask(taskId))!.owner).toBe('curia');

    const moved = await update({ owner: 'ceo', progress_note: 'Is dana@example.test the right address for Dana?' });
    expect(moved.success).toBe(true);
    expect((await repo.getTask(taskId))!.owner).toBe('ceo');
  });
});
