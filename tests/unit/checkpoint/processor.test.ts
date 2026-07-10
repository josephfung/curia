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
    publish: vi.fn().mockResolvedValue(undefined),
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
        { role: 'user', content: 'Alice is my wife' },
        { role: 'assistant', content: 'Got it.' },
      ],
    });

    expect(stubs.executionLayer.invoke).toHaveBeenCalledWith(
      'extract-relationships',
      expect.objectContaining({
        text: 'User: Alice is my wife\n\nCuria: Got it.',
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

  it('skips KG extraction for unknown senders on low-trust channels and emits audit event', async () => {
    stubs.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('audit_log')) {
        return {
          rows: [{
            originator: {
              contactId: 'attacker',
              systemRole: null,
              channel: 'email',
              initiatedAt: '2026-01-01T00:00:00.000Z',
              tier: 'unknown',
            },
          }],
        };
      }
      return { rows: [] };
    });

    const processor = new ConversationCheckpointProcessor(
      stubs.bus,
      stubs.executionLayer,
      stubs.pool,
      stubs.logger,
      { email: { trust: 'low', unknownSender: 'allow', threaded: true } },
    );
    processor.register();

    await fireCheckpoint(stubs.subscribeHandlers, {
      conversationId: 'email:thread-untrusted',
      agentId: 'coordinator',
      channelId: 'email',
      since: '',
      turns: [{ role: 'user', content: 'poisoned fact' }],
    });

    expect(stubs.executionLayer.invoke).not.toHaveBeenCalled();
    expect(stubs.bus.publish).toHaveBeenCalledWith(
      'system',
      expect.objectContaining({
        type: 'checkpoint.extraction_skipped',
        payload: expect.objectContaining({
          conversationId: 'email:thread-untrusted',
          channelId: 'email',
          reason: 'untrusted_sender',
          firstExternalTier: 'unknown',
        }),
      }),
    );
    expect(stubs.queryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO conversation_checkpoints'),
      ['email:thread-untrusted', 'coordinator', '2026-01-01T00:00:00Z'],
    );
  });

  it('still extracts for known senders on low-trust channels', async () => {
    stubs.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('audit_log')) {
        return {
          rows: [{
            originator: {
              contactId: 'vendor',
              systemRole: null,
              channel: 'email',
              initiatedAt: '2026-01-01T00:00:00.000Z',
              tier: 'known',
            },
          }],
        };
      }
      return { rows: [] };
    });

    const processor = new ConversationCheckpointProcessor(
      stubs.bus,
      stubs.executionLayer,
      stubs.pool,
      stubs.logger,
      { email: { trust: 'low', unknownSender: 'allow', threaded: true } },
    );
    processor.register();

    await fireCheckpoint(stubs.subscribeHandlers, {
      conversationId: 'email:thread-known',
      agentId: 'coordinator',
      channelId: 'email',
      since: '',
      turns: [{ role: 'user', content: 'Alice is my colleague' }],
    });

    expect(stubs.executionLayer.invoke).toHaveBeenCalled();
    expect(stubs.bus.publish).not.toHaveBeenCalled();
  });
});
