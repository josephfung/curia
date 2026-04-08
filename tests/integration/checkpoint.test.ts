// Integration test: ConversationCheckpointProcessor full round-trip.
//
// Uses real Postgres (DATABASE_URL must be set) and a mock ExecutionLayer
// so no real LLM API calls are made. Tests that:
// 1. The processor creates a watermark row after the first checkpoint
// 2. The processor advances the watermark on subsequent checkpoints
// 3. The watermark is respected — only turns after `since` are passed to skills

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { WorkingMemory } from '../../src/memory/working-memory.js';
import { ConversationCheckpointProcessor } from '../../src/checkpoint/processor.js';
import { createConversationCheckpoint } from '../../src/bus/events.js';
import type { ExecutionLayer } from '../../src/skills/execution.js';
import type { EventBus } from '../../src/bus/bus.js';
import type { Logger } from '../../src/logger.js';

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
  let memory: WorkingMemory;

  // Unique conversation ID per test run to avoid cross-run interference
  const conversationId = `test:checkpoint-${Date.now()}`;
  const agentId = 'coordinator';

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    memory = WorkingMemory.createWithPostgres(pool as any, {
      info: () => {}, error: () => {}, warn: () => {}, debug: () => {},
    } as any);

    // Insert two initial turns
    await memory.addTurn(conversationId, agentId, { role: 'user', content: 'Xiaopu Fung is my wife' });
    await memory.addTurn(conversationId, agentId, { role: 'assistant', content: 'Got it, I will remember that.' });
  });

  afterAll(async () => {
    await pool.query('DELETE FROM conversation_checkpoints WHERE conversation_id = $1', [conversationId]);
    await pool.query('DELETE FROM working_memory WHERE conversation_id = $1', [conversationId]);
    await pool.end();
  });

  it('creates a watermark and calls the skill with the full transcript', async () => {
    const invokedArgs: Array<{ name: string; input: Record<string, unknown> }> = [];
    const executionLayer = {
      invoke: vi.fn(async (name: string, input: Record<string, unknown>) => {
        invokedArgs.push({ name, input });
        return { success: true, data: {} };
      }),
    } as unknown as ExecutionLayer;

    const { bus, logger } = makeBusAndLogger();
    const processor = new ConversationCheckpointProcessor(bus, executionLayer, pool as any, logger);
    processor.register();

    // Fire checkpoint directly (bypass debounce)
    const event = createConversationCheckpoint({
      conversationId,
      agentId,
      channelId: 'test',
      since: '',
      turns: [
        { role: 'user', content: 'Xiaopu Fung is my wife' },
        { role: 'assistant', content: 'Got it, I will remember that.' },
      ],
    });

    // Retrieve the registered handler and call it directly
    const handler = (bus.subscribe as ReturnType<typeof vi.fn>).mock.calls[0][2] as (e: unknown) => Promise<void>;
    await handler(event);

    // Skill was invoked with concatenated transcript
    expect(invokedArgs).toHaveLength(1);
    expect(invokedArgs[0]!.name).toBe('extract-relationships');
    expect(invokedArgs[0]!.input['text']).toContain('Xiaopu Fung');
    expect(invokedArgs[0]!.input['source']).toContain(conversationId);

    // Watermark was created
    const watermark = await pool.query(
      'SELECT last_checkpoint_at FROM conversation_checkpoints WHERE conversation_id = $1 AND agent_id = $2',
      [conversationId, agentId],
    );
    expect(watermark.rows).toHaveLength(1);
    expect(new Date(watermark.rows[0].last_checkpoint_at).getTime()).toBeGreaterThan(Date.now() - 10_000);
  });

  it('respects the watermark — second checkpoint only passes new turns to skills', async () => {
    // Insert two new turns after the first checkpoint
    await memory.addTurn(conversationId, agentId, { role: 'user', content: 'Ada Chen leads Project Orion' });
    await memory.addTurn(conversationId, agentId, { role: 'assistant', content: 'Noted.' });

    // Get current watermark (set by the first test)
    const before = await pool.query(
      'SELECT last_checkpoint_at FROM conversation_checkpoints WHERE conversation_id = $1 AND agent_id = $2',
      [conversationId, agentId],
    );
    const since: string = before.rows[0].last_checkpoint_at;

    const invokedTexts: string[] = [];
    const executionLayer = {
      invoke: vi.fn(async (_name: string, input: Record<string, unknown>) => {
        invokedTexts.push(input['text'] as string);
        return { success: true, data: {} };
      }),
    } as unknown as ExecutionLayer;

    const { bus, logger } = makeBusAndLogger();
    const processor = new ConversationCheckpointProcessor(bus, executionLayer, pool as any, logger);
    processor.register();

    // Fire second checkpoint with only the new turns
    const event = createConversationCheckpoint({
      conversationId,
      agentId,
      channelId: 'test',
      since,
      turns: [
        { role: 'user', content: 'Ada Chen leads Project Orion' },
        { role: 'assistant', content: 'Noted.' },
      ],
    });

    const handler = (bus.subscribe as ReturnType<typeof vi.fn>).mock.calls[0][2] as (e: unknown) => Promise<void>;
    await handler(event);

    // Only the two new turns in the transcript — not the original wife turns
    expect(invokedTexts).toHaveLength(1);
    expect(invokedTexts[0]).toContain('Ada Chen');
    expect(invokedTexts[0]).not.toContain('Xiaopu');

    // Watermark was advanced
    const after = await pool.query(
      'SELECT last_checkpoint_at FROM conversation_checkpoints WHERE conversation_id = $1 AND agent_id = $2',
      [conversationId, agentId],
    );
    expect(new Date(after.rows[0].last_checkpoint_at).getTime())
      .toBeGreaterThan(new Date(since).getTime());
  });
});
