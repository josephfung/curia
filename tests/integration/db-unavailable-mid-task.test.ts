/**
 * Integration-style coverage for mid-task DB unavailability (#1381).
 *
 * Uses a real Postgres pool when DATABASE_URL is set, then points WorkingMemory
 * at a sabotaged pool that rejects with ECONNREFUSED — simulating Postgres
 * going away after dispatch. Asserts the agent fails with a retryable
 * DATABASE_UNAVAILABLE error rather than hanging.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { EventBus } from '../../src/bus/bus.js';
import {
  createAgentTask,
  type AgentResponseEvent,
  type AgentErrorEvent,
} from '../../src/bus/events.js';
import type { LLMProvider } from '../../src/agents/llm/provider.js';
import { createLogger } from '../../src/logger.js';
import { WorkingMemory } from '../../src/memory/working-memory.js';
import { createPool, type DbPool } from '../../src/db/connection.js';
import { AuditLogger } from '../../src/audit/logger.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const hasDb = !!process.env['DATABASE_URL'];
const describeIf = hasDb ? describe : describe.skip;

const MOCK_PROVENANCE = {
  requestedModel: 'mock-model',
  actualModel: 'mock-model',
  providerRequestId: 'msg_mock_int',
} as const;

const CONV_ID_PREFIX = 'conv-db-int-';

describeIf('integration: database unavailable mid-task (#1381)', () => {
  let healthyPool: DbPool;

  beforeAll(async () => {
    healthyPool = createPool(process.env['DATABASE_URL']!, createLogger('error'));
    // Refuse to write audit_log rows against anything other than curia_test.
    await requireCuriaTestDatabase(healthyPool);
  });

  afterAll(async () => {
    try {
      await healthyPool.query(
        `DELETE FROM audit_log WHERE conversation_id LIKE $1`,
        [`${CONV_ID_PREFIX}%`],
      );
    } catch (err) {
      // Cleanup must not block pool shutdown.
      createLogger('error').error({ err }, 'db-unavailable integration: audit_log cleanup failed');
    }
    await healthyPool.end();
  });

  it('task fails gracefully with retryable error when DB goes down mid-task', async () => {
    // Prove the real pool is healthy first (mirrors production boot probe).
    await healthyPool.query('SELECT 1');

    const logger = createLogger('error');
    const auditLogger = new AuditLogger(healthyPool, logger);
    const bus = new EventBus(
      logger,
      (event) => auditLogger.log(event),
      (id) => auditLogger.markAcknowledged(id),
    );

    const responses: AgentResponseEvent[] = [];
    const errors: AgentErrorEvent[] = [];
    bus.subscribe('agent.response', 'dispatch', (e) => {
      responses.push(e as AgentResponseEvent);
    });
    bus.subscribe('agent.error', 'system', (e) => {
      errors.push(e as AgentErrorEvent);
    });

    // Sabotaged pool: every query fails as if Postgres vanished after dispatch.
    const deadPool = {
      query: vi.fn().mockRejectedValue(
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
          code: 'ECONNREFUSED',
        }),
      ),
      on: vi.fn(),
      end: vi.fn(),
    } as unknown as DbPool;

    const memory = WorkingMemory.createWithPostgres(deadPool, logger);
    const provider: LLMProvider = {
      id: 'mock',
      chat: vi.fn().mockResolvedValue({
        type: 'text' as const,
        content: 'unreachable',
        usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        provenance: MOCK_PROVENANCE,
      }),
    };

    const runtime = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'test',
      provider,
      resolvedModel: 'mock-model',
      bus,
      logger,
      memory,
    });
    runtime.register();

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: `${CONV_ID_PREFIX}${Date.now()}`,
      channelId: 'cli',
      senderId: 'user',
      content: 'ping',
      parentEventId: 'parent-int-db',
    });

    // Dispatch still works (audit uses healthyPool). Mid-task memory hits deadPool.
    await bus.publish('dispatch', task);

    expect(provider.chat).not.toHaveBeenCalled();
    expect(errors.some((e) => e.payload.errorType === 'DATABASE_UNAVAILABLE')).toBe(true);
    const errEvt = errors.find((e) => e.payload.errorType === 'DATABASE_UNAVAILABLE');
    expect(errEvt!.payload.retryable).toBe(true);
    expect(responses.some((r) => r.payload.isError && r.payload.errorType === 'DATABASE_UNAVAILABLE')).toBe(
      true,
    );
  });
});
