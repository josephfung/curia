// Unit tests for EventRouter.waitForResponse — the publish/wait primitive behind
// POST /api/messages and POST /api/kg/chat/messages.
//
// Regression coverage for #983: a chat POST whose client disconnects or is
// superseded before the agent responds must NOT produce an unhandledRejection
// (which previously crashed the entire multi-agent process). The contract is now
// "waitForResponse never rejects — it always resolves with a discriminated
// WaitResult", which makes an unhandled rejection structurally impossible.

import { describe, it, expect, vi } from 'vitest';
import { EventRouter, MessageRejectedError } from '../../../../src/channels/http/event-router.js';
import type { EventBus } from '../../../../src/bus/bus.js';
import type { BusEvent } from '../../../../src/bus/events.js';
import type { Logger } from '../../../../src/logger.js';

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

// A fake bus that captures the EventRouter's subscribers so a test can emit
// events directly into them without standing up the real EventBus.
function createBus(): { bus: EventBus; emit: (event: BusEvent) => void } {
  const handlers = new Map<string, (event: BusEvent) => void>();
  const bus = {
    subscribe: (type: string, _layer: string, handler: (event: BusEvent) => void) => {
      handlers.set(type, handler);
    },
  } as unknown as EventBus;
  return { bus, emit: (event: BusEvent) => handlers.get(event.type)?.(event) };
}

function makeRouter(): { router: EventRouter; emit: (event: BusEvent) => void } {
  const { bus, emit } = createBus();
  const router = new EventRouter(createLogger());
  router.setupSubscriptions(bus);
  return { router, emit };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('EventRouter.waitForResponse', () => {
  it('resolves { ok: true, content } when an outbound.message arrives', async () => {
    const { router, emit } = makeRouter();
    const promise = router.waitForResponse('c1', 1000);

    emit({
      type: 'outbound.message',
      timestamp: '2026-06-15T00:00:00.000Z',
      payload: { channelId: 'web', conversationId: 'c1', content: 'hi there' },
    } as unknown as BusEvent);

    await expect(promise).resolves.toEqual({ ok: true, content: 'hi there' });
  });

  it('resolves { ok: false, kind: "timeout" } when no response arrives in time', async () => {
    const { router } = makeRouter();
    await expect(router.waitForResponse('c2', 10)).resolves.toEqual({ ok: false, kind: 'timeout' });
  });

  it('resolves the first waiter with { ok: false, kind: "superseded" } when a second waiter takes the slot', async () => {
    const { router, emit } = makeRouter();
    const first = router.waitForResponse('c3', 1000);
    const second = router.waitForResponse('c3', 1000);

    await expect(first).resolves.toEqual({ ok: false, kind: 'superseded' });

    // Settle the second waiter so its timer doesn't dangle past the test.
    emit({
      type: 'outbound.message',
      timestamp: '2026-06-15T00:00:00.000Z',
      payload: { channelId: 'web', conversationId: 'c3', content: 'done' },
    } as unknown as BusEvent);
    await expect(second).resolves.toEqual({ ok: true, content: 'done' });
  });

  it('resolves { ok: false, kind: "rejected", error } when the message is rejected by policy', async () => {
    const { router, emit } = makeRouter();
    const promise = router.waitForResponse('c4', 1000);

    emit({
      type: 'message.rejected',
      timestamp: '2026-06-15T00:00:00.000Z',
      payload: { channelId: 'web', conversationId: 'c4', senderId: 'x', reason: 'blocked_sender' },
    } as unknown as BusEvent);

    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a non-ok result');
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error('expected a rejected result');
    expect(result.error).toBeInstanceOf(MessageRejectedError);
    expect(result.error.reason).toBe('blocked_sender');
  });

  // The core regression for #983: when nothing is awaiting the promise (client
  // disconnected / superseded), neither the timeout timer nor the supersede path
  // may surface as an unhandledRejection on the process.
  it('never triggers process unhandledRejection on the timeout or supersede paths', async () => {
    const { router } = makeRouter();
    const captured: unknown[] = [];
    const listener = (reason: unknown) => captured.push(reason);
    process.on('unhandledRejection', listener);

    try {
      // Timeout path with no consumer awaiting the promise.
      void router.waitForResponse('orphan-timeout', 10);

      // Supersede path: the first waiter is rejected-internally with no consumer;
      // the second resolves via its own short timeout so no timer dangles.
      void router.waitForResponse('orphan-supersede', 30);
      void router.waitForResponse('orphan-supersede', 30);

      // Give both the timers and any unhandledRejection microtasks room to fire.
      await delay(80);
    } finally {
      process.off('unhandledRejection', listener);
    }

    expect(captured).toEqual([]);
  });
});
