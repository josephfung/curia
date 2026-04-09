// Integration test: ConversationCheckpointProcessor full round-trip.
//
// Uses real Postgres (DATABASE_URL must be set) and a mock ExecutionLayer
// so no real LLM API calls are made. Tests that:
// 1. The processor creates a watermark row after the first checkpoint
// 2. The watermark is respected — only turns after `since` are passed to skills

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { WorkingMemory } from '../../src/memory/working-memory.js';
import { ConversationCheckpointProcessor } from '../../src/checkpoint/processor.js';
import { createConversationCheckpoint } from '../../src/bus/events.js';
import type { ExecutionLayer } from '../../src/skills/execution.js';
import type { EventBus } from '../../src/bus/bus.js';
import type { Logger } from '../../src/logger.js';
import type { DbPool } from '../../src/db/connection.js';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

function makeBusAndLogger() {
  const bus = { subscribe: vi.fn(), publish: vi.fn() } as unknown as EventBus;
  const logger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
  return { bus, logger };
}

describeIf('ConversationCheckpointProcessor — integration', () => {
  let pool: pg.Pool;

  const agentId = 'coordinator';

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates a watermark and calls the skill with the full transcript', async () => {
    // Each test gets its own conversationId so tests are fully independent
    const conversationId = `test:checkpoint-first-${Date.now()}`;
    const { logger } = makeBusAndLogger();
    const memory = WorkingMemory.createWithPostgres(pool as unknown as DbPool, logger);

    await memory.addTurn(conversationId, agentId, { role: 'user', content: 'Xiaopu Fung is my wife' });
    await memory.addTurn(conversationId, agentId, { role: 'assistant', content: 'Got it, I will remember that.' });

    try {
      const invokedArgs: Array<{ name: string; input: Record<string, unknown> }> = [];
      const executionLayer = {
        invoke: vi.fn(async (name: string, input: Record<string, unknown>) => {
          invokedArgs.push({ name, input });
          return { success: true, data: {} };
        }),
      } as unknown as ExecutionLayer;

      const { bus, logger: processorLogger } = makeBusAndLogger();
      const processor = new ConversationCheckpointProcessor(
        bus, executionLayer, pool as unknown as DbPool, processorLogger,
      );
      processor.register();

      // Determine `through`: the newest turn's created_at
      const turnsResult = await pool.query<{ created_at: string }>(
        `SELECT created_at FROM working_memory
         WHERE conversation_id = $1 AND agent_id = $2
           AND role IN ('user', 'assistant')
         ORDER BY created_at DESC LIMIT 1`,
        [conversationId, agentId],
      );
      const through = turnsResult.rows[0]!.created_at;

      const event = createConversationCheckpoint({
        conversationId,
        agentId,
        channelId: 'test',
        since: '',
        through,
        turns: [
          { role: 'user', content: 'Xiaopu Fung is my wife' },
          { role: 'assistant', content: 'Got it, I will remember that.' },
        ],
      });

      // Retrieve the registered handler and call it directly
      const handler = (bus.subscribe as ReturnType<typeof vi.fn>).mock.calls[0][2] as (e: unknown) => Promise<void>;
      await handler(event);

      // Both checkpoint skills were invoked with the same transcript
      expect(invokedArgs).toHaveLength(2);
      expect(invokedArgs[0]!.name).toBe('extract-relationships');
      expect(invokedArgs[1]!.name).toBe('extract-facts');
      expect(invokedArgs[0]!.input['text']).toContain('Xiaopu Fung');
      expect(invokedArgs[0]!.input['source']).toContain(conversationId);
      expect(invokedArgs[1]!.input['text']).toContain('Xiaopu Fung');
      expect(invokedArgs[1]!.input['source']).toContain(conversationId);

      // Watermark was created at the batch's upper bound
      const watermark = await pool.query(
        'SELECT last_checkpoint_at FROM conversation_checkpoints WHERE conversation_id = $1 AND agent_id = $2',
        [conversationId, agentId],
      );
      expect(watermark.rows).toHaveLength(1);
      expect(new Date(watermark.rows[0].last_checkpoint_at).getTime())
        .toBeGreaterThan(Date.now() - 10_000);
    } finally {
      await pool.query('DELETE FROM conversation_checkpoints WHERE conversation_id = $1', [conversationId]);
      await pool.query('DELETE FROM working_memory WHERE conversation_id = $1', [conversationId]);
    }
  });

  it('respects the watermark — second checkpoint only passes new turns to skills', async () => {
    // Self-contained: seeds its own turns, fires an initial checkpoint, then a second one
    const conversationId = `test:checkpoint-second-${Date.now()}`;
    const { logger } = makeBusAndLogger();
    const memory = WorkingMemory.createWithPostgres(pool as unknown as DbPool, logger);

    await memory.addTurn(conversationId, agentId, { role: 'user', content: 'Xiaopu Fung is my wife' });
    await memory.addTurn(conversationId, agentId, { role: 'assistant', content: 'Got it, I will remember that.' });

    try {
      // --- First checkpoint: establish the watermark ---
      const firstTurnsResult = await pool.query<{ created_at: string }>(
        `SELECT created_at FROM working_memory
         WHERE conversation_id = $1 AND agent_id = $2
           AND role IN ('user', 'assistant')
         ORDER BY created_at DESC LIMIT 1`,
        [conversationId, agentId],
      );
      const firstThrough = firstTurnsResult.rows[0]!.created_at;

      const { bus: bus1, logger: logger1 } = makeBusAndLogger();
      const proc1 = new ConversationCheckpointProcessor(
        bus1, { invoke: vi.fn().mockResolvedValue({ success: true, data: {} }) } as unknown as ExecutionLayer,
        pool as unknown as DbPool, logger1,
      );
      proc1.register();
      const handler1 = (bus1.subscribe as ReturnType<typeof vi.fn>).mock.calls[0][2] as (e: unknown) => Promise<void>;
      await handler1(createConversationCheckpoint({
        conversationId, agentId, channelId: 'test', since: '', through: firstThrough,
        turns: [
          { role: 'user', content: 'Xiaopu Fung is my wife' },
          { role: 'assistant', content: 'Got it, I will remember that.' },
        ],
      }));

      // Read back the watermark just set
      const wmRow = await pool.query(
        'SELECT last_checkpoint_at FROM conversation_checkpoints WHERE conversation_id = $1 AND agent_id = $2',
        [conversationId, agentId],
      );
      const since: string = wmRow.rows[0].last_checkpoint_at;

      // --- Add new turns after the watermark ---
      await memory.addTurn(conversationId, agentId, { role: 'user', content: 'Ada Chen leads Project Orion' });
      await memory.addTurn(conversationId, agentId, { role: 'assistant', content: 'Noted.' });

      const secondTurnsResult = await pool.query<{ created_at: string }>(
        `SELECT created_at FROM working_memory
         WHERE conversation_id = $1 AND agent_id = $2
           AND role IN ('user', 'assistant') AND created_at > $3
         ORDER BY created_at DESC LIMIT 1`,
        [conversationId, agentId, since],
      );
      const secondThrough = secondTurnsResult.rows[0]!.created_at;

      // --- Second checkpoint: only new turns ---
      const invokedTexts: string[] = [];
      const executionLayer2 = {
        invoke: vi.fn(async (_name: string, input: Record<string, unknown>) => {
          invokedTexts.push(input['text'] as string);
          return { success: true, data: {} };
        }),
      } as unknown as ExecutionLayer;

      const { bus: bus2, logger: logger2 } = makeBusAndLogger();
      const proc2 = new ConversationCheckpointProcessor(
        bus2, executionLayer2, pool as unknown as DbPool, logger2,
      );
      proc2.register();
      const handler2 = (bus2.subscribe as ReturnType<typeof vi.fn>).mock.calls[0][2] as (e: unknown) => Promise<void>;
      await handler2(createConversationCheckpoint({
        conversationId, agentId, channelId: 'test', since, through: secondThrough,
        turns: [
          { role: 'user', content: 'Ada Chen leads Project Orion' },
          { role: 'assistant', content: 'Noted.' },
        ],
      }));

      // Both checkpoint skills received only the new turns — not the original wife turns.
      // Each skill receives the same transcript, so we get 2 entries (one per skill).
      expect(invokedTexts).toHaveLength(2);
      for (const txt of invokedTexts) {
        expect(txt).toContain('Ada Chen');
        expect(txt).not.toContain('Xiaopu');
      }

      // Watermark was advanced past the first checkpoint
      const after = await pool.query(
        'SELECT last_checkpoint_at FROM conversation_checkpoints WHERE conversation_id = $1 AND agent_id = $2',
        [conversationId, agentId],
      );
      expect(new Date(after.rows[0].last_checkpoint_at).getTime())
        .toBeGreaterThanOrEqual(new Date(since).getTime());
    } finally {
      await pool.query('DELETE FROM conversation_checkpoints WHERE conversation_id = $1', [conversationId]);
      await pool.query('DELETE FROM working_memory WHERE conversation_id = $1', [conversationId]);
    }
  });
});
