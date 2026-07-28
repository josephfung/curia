// handler.test.ts — async-offramp skill (#1614 / ADR-038 gate #3).
import { describe, it, expect, beforeEach } from 'vitest';
import pino from 'pino';
import { AsyncOfframpHandler, resetAsyncOfframpDedupForTests } from './handler.js';
import type { ToolContext } from '../../src/skills/types.js';
import type { EventBus } from '../../src/bus/bus.js';
import type { AgentTaskEvent, BusEvent } from '../../src/bus/events.js';

function makeBus(opts: { failPublish?: boolean } = {}) {
  const published: BusEvent[] = [];
  const bus = {
    subscribe() {
      /* unused */
    },
    async publish(_layer: string, event: BusEvent) {
      if (opts.failPublish) {
        throw new Error('bus unavailable');
      }
      published.push(event);
    },
  } as unknown as EventBus;
  return { bus, published };
}

function makeCtx(
  bus: EventBus,
  input: Record<string, unknown>,
  over: Partial<ToolContext> = {},
): ToolContext {
  return {
    input,
    log: pino({ level: 'silent' }),
    bus,
    agentId: 'coordinator',
    conversationId: 'voice:session-abc',
    channelId: 'voice',
    taskEventId: 'voice-session-abc',
    liveTurn: true,
    caller: { contactId: 'ceo-1', role: 'ceo', channel: 'voice' },
    taskMetadata: {
      originator: {
        contactId: 'ceo-1',
        systemRole: 'principal',
        channel: 'voice',
        initiatedAt: '2026-07-28T12:00:00.000Z',
        tier: 'known',
      },
      voiceSessionId: 'session-abc',
    },
    ...over,
  } as unknown as ToolContext;
}

const handler = new AsyncOfframpHandler();

describe('AsyncOfframpHandler', () => {
  beforeEach(() => {
    resetAsyncOfframpDedupForTests();
  });

  it('enqueues a coordinator agent.task on the dispatch path (happy path)', async () => {
    const { bus, published } = makeBus();
    const result = await handler.execute(
      makeCtx(bus, {
        brief: 'Draft a research deck on Q3 competitors and email me when ready',
        follow_up_channel: 'email',
      }),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as Record<string, unknown>;
    expect(data).toMatchObject({
      accepted: true,
      follow_up_channel: 'email',
      deduplicated: false,
    });
    expect(typeof data['task_event_id']).toBe('string');

    expect(published).toHaveLength(1);
    const task = published[0] as AgentTaskEvent;
    expect(task.type).toBe('agent.task');
    expect(task.payload.agentId).toBe('coordinator');
    expect(task.payload.channelId).toBe('internal');
    expect(task.payload.senderId).toBe('ceo-1');
    expect(task.payload.liveTurn).toBeUndefined();
    expect(task.payload.content).toContain('Voice async off-ramp');
    expect(task.payload.content).toContain('Draft a research deck');
    expect(task.payload.content).toContain('email-send');
    expect(task.payload.metadata).toMatchObject({
      voiceOfframp: true,
      followUpChannel: 'email',
      sourceVoiceConversationId: 'voice:session-abc',
      originator: { contactId: 'ceo-1', systemRole: 'principal' },
    });
    expect(task.parentEventId).toBe('voice-session-abc');
  });

  it('defaults follow_up_channel to email and uses signal-send when signal', async () => {
    const { bus, published } = makeBus();
    const result = await handler.execute(
      makeCtx(bus, { brief: 'Triage my inbox for vendor invoices' }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>)['follow_up_channel']).toBe('email');
    }
    expect((published[0] as AgentTaskEvent).payload.content).toContain('email-send');

    resetAsyncOfframpDedupForTests();
    const { bus: bus2, published: pub2 } = makeBus();
    await handler.execute(makeCtx(bus2, { brief: 'Same work via Signal', follow_up_channel: 'signal' }));
    expect((pub2[0] as AgentTaskEvent).payload.content).toContain('signal-send');
  });

  it('is idempotent — duplicate call does not spawn a second task', async () => {
    const { bus, published } = makeBus();
    const input = {
      brief: 'Build the competitive research deck',
      follow_up_channel: 'email',
    };
    const first = await handler.execute(makeCtx(bus, input));
    const second = await handler.execute(makeCtx(bus, input));

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) return;

    expect(published).toHaveLength(1);
    const firstData = first.data as Record<string, unknown>;
    expect(second.data).toMatchObject({
      accepted: true,
      deduplicated: true,
      task_event_id: firstData['task_event_id'],
    });
  });

  it('honors an explicit idempotency_key across brief wording drift', async () => {
    const { bus, published } = makeBus();
    const first = await handler.execute(
      makeCtx(bus, {
        brief: 'Do the deck',
        follow_up_channel: 'email',
        idempotency_key: 'call-1',
      }),
    );
    const second = await handler.execute(
      makeCtx(bus, {
        brief: 'Do the research deck please',
        follow_up_channel: 'email',
        idempotency_key: 'call-1',
      }),
    );
    expect(published).toHaveLength(1);
    expect(first.success && second.success).toBe(true);
    if (first.success && second.success) {
      const firstData = first.data as Record<string, unknown>;
      const secondData = second.data as Record<string, unknown>;
      expect(secondData['deduplicated']).toBe(true);
      expect(secondData['task_event_id']).toBe(firstData['task_event_id']);
    }
  });

  it('returns honest failure when enqueue publish fails (no false confirm)', async () => {
    const { bus, published } = makeBus({ failPublish: true });
    const result = await handler.execute(
      makeCtx(bus, { brief: 'Heavy research ask', follow_up_channel: 'email' }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/failed to hand off/i);
    }
    expect(published).toHaveLength(0);

    // Dedup claim rolled back — a retry after recovery can succeed.
    const { bus: bus2, published: pub2 } = makeBus();
    const retry = await handler.execute(
      makeCtx(bus2, { brief: 'Heavy research ask', follow_up_channel: 'email' }),
    );
    expect(retry.success).toBe(true);
    expect(pub2).toHaveLength(1);
  });

  it('rejects missing brief and invalid follow_up_channel', async () => {
    const { bus } = makeBus();
    const missing = await handler.execute(makeCtx(bus, {}));
    expect(missing.success).toBe(false);
    if (!missing.success) expect(missing.error).toMatch(/brief/i);

    const badChannel = await handler.execute(
      makeCtx(bus, { brief: 'ok', follow_up_channel: 'carrier-pigeon' }),
    );
    expect(badChannel.success).toBe(false);
    if (!badChannel.success) expect(badChannel.error).toMatch(/signal.*email/i);
  });

  it('returns error when bus is unavailable (honest degradation)', async () => {
    const result = await handler.execute(
      makeCtx(null as unknown as EventBus, { brief: 'anything' }, { bus: undefined }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/bus/i);
  });

  it('negative contract: handler is opt-in — no publish without an execute call', async () => {
    // In-scope live-call asks must stay on the voice turn (spike fixture
    // offramp-should-not-trigger). The tool never auto-fires: without execute(),
    // nothing is enqueued. Distinct briefs still enqueue separately when called.
    const { bus, published } = makeBus();
    expect(published).toHaveLength(0);
    await handler.execute(makeCtx(bus, { brief: 'Heavyweight A', follow_up_channel: 'email' }));
    await handler.execute(makeCtx(bus, { brief: 'Heavyweight B', follow_up_channel: 'email' }));
    expect(published).toHaveLength(2);
  });
});
