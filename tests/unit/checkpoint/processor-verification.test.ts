// Checkpoint extraction scrubs tracked sign-in codes before the transcript reaches
// extract-facts / extract-relationships (#2017, design §5).
import { describe, it, expect, vi } from 'vitest';
import { ConversationCheckpointProcessor } from '../../../src/checkpoint/processor.js';
import { CodeTracker } from '../../../src/verification/code-tracker.js';
import type { VerificationRuntime } from '../../../src/verification/index.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { ExecutionLayer } from '../../../src/skills/execution.js';
import type { DbPool } from '../../../src/db/connection.js';
import type { Logger } from '../../../src/logger.js';
import { createConversationCheckpoint } from '../../../src/bus/events.js';

function setup(withRuntime: boolean) {
  const handlers = new Map<string, (event: unknown) => Promise<void>>();
  const bus = {
    subscribe: vi.fn((type: string, _layer: string, handler: (e: unknown) => Promise<void>) => {
      handlers.set(type, handler);
    }),
    publish: vi.fn().mockResolvedValue(undefined),
  } as unknown as EventBus;
  const invoke = vi.fn().mockResolvedValue({ success: true, data: {} });
  const executionLayer = { invoke } as unknown as ExecutionLayer;
  const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as DbPool;
  const logger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;

  const tracker = new CodeTracker({ ttlMinutesAfterClose: 120 });
  tracker.register('ver-1', 'aircanada.com', '739204');
  const runtime = { tracker } as unknown as VerificationRuntime;

  const processor = new ConversationCheckpointProcessor(
    bus, executionLayer, pool, logger, { cli: { trust: 'high' } } as never,
    withRuntime ? runtime : undefined,
  );
  processor.register();

  async function fire(turns: Array<{ role: 'user' | 'assistant'; content: string }>) {
    const event = createConversationCheckpoint({
      conversationId: 'conv-1', agentId: 'coordinator', channelId: 'cli',
      since: '2026-01-01T00:00:00Z', through: '2026-01-01T00:00:00Z', turns,
    });
    await handlers.get('conversation.checkpoint')!(event);
  }
  return { invoke, fire };
}

const turns = [
  { role: 'user' as const, content: 'log me in to Air Canada' },
  { role: 'assistant' as const, content: 'The code is 739204, entering it now.' },
];

describe('ConversationCheckpointProcessor sign-in code scrubbing (#2017)', () => {
  it('hands extract-facts and extract-relationships a transcript with [sign-in code]', async () => {
    const { invoke, fire } = setup(true);
    await fire(turns);

    for (const name of ['extract-facts', 'extract-relationships']) {
      const call = invoke.mock.calls.find(c => c[0] === name);
      expect(call).toBeDefined();
      const text = (call![1] as { text: string }).text;
      expect(text).toContain('[sign-in code]');
      expect(text).not.toContain('739204');
    }
  });

  it('leaves the transcript unchanged when no verification runtime is wired', async () => {
    const { invoke, fire } = setup(false);
    await fire(turns);

    const call = invoke.mock.calls.find(c => c[0] === 'extract-facts');
    expect((call![1] as { text: string }).text).toContain('739204');
  });
});
