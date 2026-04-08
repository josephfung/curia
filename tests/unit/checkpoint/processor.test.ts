import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationCheckpointProcessor } from '../../../src/checkpoint/processor.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { ExecutionLayer } from '../../../src/skills/execution.js';
import type { DbPool } from '../../../src/db/connection.js';
import type { Logger } from '../../../src/logger.js';
import { createConversationCheckpoint } from '../../../src/bus/events.js';

function makeStubs() {
  const subscribeHandlers = new Map<string, (event: unknown) => Promise<void>>();
  const bus = {
    subscribe: vi.fn((eventType: string, _layer: string, handler: (e: unknown) => Promise<void>) => {
      subscribeHandlers.set(eventType, handler);
    }),
  } as unknown as EventBus;

  const executionLayer = {
    invoke: vi.fn().mockResolvedValue({ success: true, data: {} }),
  } as unknown as ExecutionLayer;

  const queryMock = vi.fn().mockResolvedValue({ rows: [] });
  const pool = { query: queryMock } as unknown as DbPool;

  const logger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;

  return { bus, executionLayer, pool, logger, subscribeHandlers, queryMock };
}

async function fireCheckpoint(
  subscribeHandlers: Map<string, (event: unknown) => Promise<void>>,
  payload: {
    conversationId: string;
    agentId: string;
    channelId: string;
    since: string;
    through?: string;
    turns: Array<{ role: 'user' | 'assistant'; content: string }>;
  },
) {
  const event = createConversationCheckpoint({
    ...payload,
    through: payload.through ?? '2026-01-01T00:00:00Z',
  });
  const handler = subscribeHandlers.get('conversation.checkpoint');
  if (!handler) throw new Error('No handler registered for conversation.checkpoint');
  await handler(event);
}

describe('ConversationCheckpointProcessor', () => {
  let stubs: ReturnType<typeof makeStubs>;

  beforeEach(() => {
    stubs = makeStubs();
  });

  it('registers a conversation.checkpoint subscriber on register()', () => {
    const processor = new ConversationCheckpointProcessor(
      stubs.bus, stubs.executionLayer, stubs.pool, stubs.logger,
    );
    processor.register();
    expect(stubs.bus.subscribe).toHaveBeenCalledWith(
      'conversation.checkpoint', 'system', expect.any(Function),
    );
  });

  it('calls extract-relationships with concatenated transcript', async () => {
    const processor = new ConversationCheckpointProcessor(
      stubs.bus, stubs.executionLayer, stubs.pool, stubs.logger,
    );
    processor.register();

    await fireCheckpoint(stubs.subscribeHandlers, {
      conversationId: 'email:thread-abc',
      agentId: 'coordinator',
      channelId: 'email',
      since: '',
      turns: [
        { role: 'user', content: 'Xiaopu is my wife' },
        { role: 'assistant', content: 'Got it.' },
      ],
    });

    expect(stubs.executionLayer.invoke).toHaveBeenCalledWith(
      'extract-relationships',
      expect.objectContaining({
        text: 'User: Xiaopu is my wife\n\nCuria: Got it.',
        source: expect.stringContaining('email:thread-abc'),
      }),
      expect.anything(),
    );
  });

  it('advances the watermark after skills run', async () => {
    const processor = new ConversationCheckpointProcessor(
      stubs.bus, stubs.executionLayer, stubs.pool, stubs.logger,
    );
    processor.register();

    await fireCheckpoint(stubs.subscribeHandlers, {
      conversationId: 'email:thread-abc',
      agentId: 'coordinator',
      channelId: 'email',
      since: '',
      turns: [{ role: 'user', content: 'test' }],
    });

    expect(stubs.queryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO conversation_checkpoints'),
      ['email:thread-abc', 'coordinator', '2026-01-01T00:00:00Z'],
    );
  });

  it('advances the watermark even when a skill fails', async () => {
    stubs.executionLayer.invoke = vi.fn().mockRejectedValue(new Error('API timeout'));
    const processor = new ConversationCheckpointProcessor(
      stubs.bus, stubs.executionLayer, stubs.pool, stubs.logger,
    );
    processor.register();

    await fireCheckpoint(stubs.subscribeHandlers, {
      conversationId: 'email:thread-abc',
      agentId: 'coordinator',
      channelId: 'email',
      since: '',
      turns: [{ role: 'user', content: 'test' }],
    });

    // Watermark upsert still called despite skill failure
    expect(stubs.queryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO conversation_checkpoints'),
      expect.any(Array),
    );
  });

  it('does nothing when turns list is empty', async () => {
    const processor = new ConversationCheckpointProcessor(
      stubs.bus, stubs.executionLayer, stubs.pool, stubs.logger,
    );
    processor.register();

    await fireCheckpoint(stubs.subscribeHandlers, {
      conversationId: 'email:thread-abc',
      agentId: 'coordinator',
      channelId: 'email',
      since: '',
      turns: [],
    });

    expect(stubs.executionLayer.invoke).not.toHaveBeenCalled();
    expect(stubs.queryMock).not.toHaveBeenCalled();
  });
});
