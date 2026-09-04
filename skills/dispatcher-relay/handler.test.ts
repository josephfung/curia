import { describe, it, expect, vi } from 'vitest';
import { DispatcherRelayHandler } from './handler.js';
import type { ToolContext } from '../../src/skills/types.js';
import type { BusEvent } from '../../src/bus/events.js';

function makeCtx(overrides: Partial<ToolContext> & { input: Record<string, unknown> }): ToolContext {
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    bus: {
      publish: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  } as unknown as ToolContext;
}

describe('DispatcherRelayHandler', () => {
  it('publishes outbound.message for an approved relay', async () => {
    const published: BusEvent[] = [];
    const bus = {
      publish: vi.fn(async (_layer: string, event: BusEvent) => {
        published.push(event);
      }),
    };
    const handler = new DispatcherRelayHandler();
    const result = await handler.execute(makeCtx({
      bus: bus as unknown as ToolContext['bus'],
      input: {
        channelId: 'email',
        to: 'dana@example.com',
        body: 'Approved reply body',
        conversationId: 'email:thread-1',
      },
      taskEventId: 'task-1',
    }));

    expect(result.success).toBe(true);
    expect(bus.publish).toHaveBeenCalledWith('dispatch', expect.objectContaining({
      type: 'outbound.message',
    }));
    expect(published[0]?.type).toBe('outbound.message');
    if (published[0]?.type === 'outbound.message') {
      expect(published[0].payload.content).toBe('Approved reply body');
      expect(published[0].payload.recipientId).toBe('dana@example.com');
      expect(published[0].payload.channelId).toBe('email');
    }
  });

  it('rejects body longer than RELAY_BODY_MAX_LENGTH', async () => {
    const { RELAY_BODY_MAX_LENGTH } = await import('../../src/dispatch/relay-gate-c.js');
    const handler = new DispatcherRelayHandler();
    const result = await handler.execute(makeCtx({
      input: {
        channelId: 'email',
        to: 'a@b.com',
        body: 'z'.repeat(RELAY_BODY_MAX_LENGTH + 1),
        conversationId: 'c',
      },
      taskEventId: 'task-1',
    }));
    expect(result.success).toBe(false);
  });

  it('accepts body at exactly RELAY_BODY_MAX_LENGTH', async () => {
    const { RELAY_BODY_MAX_LENGTH } = await import('../../src/dispatch/relay-gate-c.js');
    const bus = { publish: vi.fn().mockResolvedValue(undefined) };
    const handler = new DispatcherRelayHandler();
    const result = await handler.execute(makeCtx({
      bus: bus as unknown as ToolContext['bus'],
      input: {
        channelId: 'email',
        to: 'a@b.com',
        body: 'z'.repeat(RELAY_BODY_MAX_LENGTH),
        conversationId: 'c',
      },
      taskEventId: 'task-1',
    }));
    expect(result.success).toBe(true);
  });

  it('fails when bus is missing', async () => {
    const handler = new DispatcherRelayHandler();
    const result = await handler.execute(makeCtx({
      bus: undefined,
      input: {
        channelId: 'email',
        to: 'a@b.com',
        body: 'x',
        conversationId: 'c',
      },
      taskEventId: 'task-1',
    }));
    expect(result.success).toBe(false);
  });
});
