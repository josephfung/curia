// handler.test.ts — async-offramp skill (#1614 / ADR-038 gate #3).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import pino from 'pino';
import { AsyncOfframpHandler, NOW_MODE_WAIT_MS, pendingReplyCountForTests, resetAsyncOfframpDedupForTests } from './handler.js';
import type { ToolContext } from '../../src/skills/types.js';
import { EventBus } from '../../src/bus/bus.js';
import { createAgentResponse } from '../../src/bus/events.js';
import type { AgentTaskEvent, BusEvent } from '../../src/bus/events.js';
import {
  activeLiveTurnGrantCountForTests,
  isLiveTurnGrantActive,
  resetLiveTurnGrantsForTests,
} from '../../src/autonomy/live-turn-grants.js';

function makeBus(opts: { failPublish?: boolean } = {}) {
  const published: BusEvent[] = [];
  const publish = async (_layer: string, event: BusEvent) => {
    if (opts.failPublish) {
      throw new Error('bus unavailable');
    }
    published.push(event);
  };
  const bus = {
    subscribe() {
      /* unused */
    },
    publish,
    publishDetached: publish,
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
    // The follow-up names the alias, not the address list (#2033).
    expect(task.payload.content).toContain('passing "principal" as the recipient');
    expect(task.payload.metadata).toMatchObject({
      voiceOfframp: true,
      followUpChannel: 'email',
      sourceVoiceConversationId: 'voice:session-abc',
      originator: { contactId: 'ceo-1', systemRole: 'principal' },
    });
    expect(task.parentEventId).toBe('voice-session-abc');
  });

  // PR #2433 review: Signal and email were hard-coded. With no channel named, the
  // coordinator reaches the principal by its own configured order and preferences.
  it('uses the principal\'s usual channel unless one is named, and accepts any reach channel', async () => {
    const { bus, published } = makeBus();
    const result = await handler.execute(makeCtx(bus, { brief: 'Triage my inbox for vendor invoices' }));
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as Record<string, unknown>)['follow_up_channel']).toBeNull();
    const content = (published[0] as AgentTaskEvent).payload.content;
    expect(content).toContain('Reaching the principal');
    expect(content).not.toContain('email-send');

    for (const [channel, tool] of [['signal', 'signal-send'], ['sms', 'sms-send'], ['slack', 'slack-send'], ['web', 'web-send']]) {
      resetAsyncOfframpDedupForTests();
      const { bus: named, published: sent } = makeBus();
      await handler.execute(makeCtx(named, { brief: `Same work via ${channel}`, follow_up_channel: channel }));
      expect((sent[0] as AgentTaskEvent).payload.content).toContain(tool);
    }
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

  it('scopes explicit idempotency_key to the conversation (no cross-session swallow)', async () => {
    const { bus, published } = makeBus();
    await handler.execute(
      makeCtx(bus, { brief: 'Deck A', follow_up_channel: 'email', idempotency_key: 'deck' }),
    );
    await handler.execute(
      makeCtx(
        bus,
        { brief: 'Deck B for another call', follow_up_channel: 'email', idempotency_key: 'deck' },
        { conversationId: 'voice:other-session' },
      ),
    );
    expect(published).toHaveLength(2);
  });

  it('rejects non-voice channel invocations (voice-only backstop)', async () => {
    const { bus, published } = makeBus();
    const result = await handler.execute(
      makeCtx(bus, { brief: 'Should not enqueue' }, { channelId: 'email' }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/voice-only/i);
    expect(published).toHaveLength(0);
  });

  it('resolves while a slow agent.task subscriber is still running (#2265)', async () => {
    let releaseSubscriber = (): void => {};
    const subscriberRunning = new Promise<void>((resolve) => {
      releaseSubscriber = resolve;
    });
    const writeAhead = vi.fn(async (_event: BusEvent) => {});
    const bus = new EventBus(pino({ level: 'silent' }), writeAhead);
    let subscriberEntered = false;
    bus.subscribe('agent.task', 'agent', async () => {
      subscriberEntered = true;
      await subscriberRunning;
    });

    try {
      let settled = false;
      const pending = handler.execute(makeCtx(bus, {
        brief: 'Draft the competitive research deck',
        follow_up_channel: 'email',
      })).then((result) => {
        settled = true;
        return result;
      });

      await vi.waitFor(() => {
        expect(settled).toBe(true);
        expect(subscriberEntered).toBe(true);
      });

      const result = await pending;
      expect(result.success).toBe(true);
      if (!result.success) return;
      const data = result.data as Record<string, unknown>;
      expect(data).toMatchObject({ accepted: true, deduplicated: false });
      const published = writeAhead.mock.calls[0]![0];
      expect(data['task_event_id']).toBe(published.id);
      expect(published.type).toBe('agent.task');
    } finally {
      releaseSubscriber();
    }
  });

  it('returns success false and clears the dedup claim when audit write-ahead fails (#2265)', async () => {
    const bus = new EventBus(pino({ level: 'silent' }), async () => {
      throw new Error('audit insert failed');
    });
    const subscriber = vi.fn(async () => {});
    bus.subscribe('agent.task', 'agent', subscriber);

    const input = { brief: 'Heavy research ask', follow_up_channel: 'email' };
    const result = await handler.execute(makeCtx(bus, input));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/failed to hand off/i);
    expect(subscriber).not.toHaveBeenCalled();

    const { bus: recovered, published } = makeBus();
    const retry = await handler.execute(makeCtx(recovered, input));
    expect(retry.success).toBe(true);
    if (retry.success) {
      expect((retry.data as Record<string, unknown>)['deduplicated']).toBe(false);
    }
    expect(published).toHaveLength(1);
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

// #2428: the call had only "after the call". A request the coordinator could
// finish in under a minute (create a job, sign in with a vault key) left the
// caller arguing with a voice brain that has none of those tools.
describe('AsyncOfframpHandler mode now (#2428)', () => {
  type Subscriber = (event: BusEvent) => Promise<void> | void;

  function liveBus(reply?: (task: AgentTaskEvent) => BusEvent | null) {
    const published: BusEvent[] = [];
    const subscribers: Subscriber[] = [];
    const bus = {
      subscribe(type: string, _layer: string, fn: Subscriber) {
        if (type === 'agent.response') subscribers.push(fn);
      },
      async publishDetached(_layer: string, event: BusEvent) {
        published.push(event);
        const response = event.type === 'agent.task' && reply ? reply(event as AgentTaskEvent) : null;
        if (response) queueMicrotask(() => { for (const fn of subscribers) void fn(response); });
      },
    } as unknown as EventBus;
    const respond = async (event: BusEvent) => { for (const fn of subscribers) await fn(event); };
    return { bus, published, respond, subscriberCount: () => subscribers.length };
  }

  function response(task: AgentTaskEvent, payload: { content: string; sends?: string[]; isError?: boolean }): BusEvent {
    return createAgentResponse({
      agentId: 'coordinator',
      conversationId: task.payload.conversationId,
      parentEventId: task.id,
      ...payload,
    });
  }

  beforeEach(() => {
    resetAsyncOfframpDedupForTests();
  });

  it('returns the coordinator reply on the call, with the sends that succeeded', async () => {
    const { bus, published } = liveBus((task) => response(task, { content: 'Job created; sign-in worked.', sends: [] }));
    const result = await handler.execute(makeCtx(bus, { brief: 'Set up a daily 1 PM feed check', mode: 'now' }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({ completed: true, result: 'Job created; sign-in worked.', sent: [] });
    const task = published[0] as AgentTaskEvent;
    expect(task.payload.content).toContain('still on the call');
    expect(task.payload.content).toContain('Do not message the principal about this yourself');
  });

  it('reports a coordinator failure honestly', async () => {
    const { bus } = liveBus((task) => response(task, { content: 'Something went wrong.', isError: true }));
    const result = await handler.execute(makeCtx(bus, { brief: 'Do the thing', mode: 'now' }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({ completed: false, failed: true });
  });

  it('stops waiting at the limit, says it is still working, and forwards the late result', async () => {
    vi.useFakeTimers();
    try {
      const { bus, published, respond } = liveBus();
      const pending = handler.execute(makeCtx(bus, { brief: 'Long job', mode: 'now', follow_up_channel: 'signal' }));
      await vi.advanceTimersByTimeAsync(NOW_MODE_WAIT_MS + 1);
      const result = await pending;
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data).toMatchObject({ completed: false, still_working: true, follow_up_channel: 'signal' });

      const task = published[0] as AgentTaskEvent;
      await respond(response(task, { content: 'Here is the late result.', sends: [] }));
      const forward = published[1] as AgentTaskEvent;
      expect(forward.type).toBe('agent.task');
      expect(forward.payload.content).toContain('Here is the late result.');
      expect(forward.payload.content).toContain('signal-send');
      expect(forward.payload.content).toContain('"principal"');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends the wait when the caller speaks, and still forwards the result', async () => {
    const controller = new AbortController();
    const { bus, published, respond } = liveBus();
    const pending = handler.execute(makeCtx(bus, { brief: 'Long job', mode: 'now' }, { inputSignal: controller.signal }));
    await Promise.resolve();
    controller.abort();
    const result = await pending;
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({ completed: false, still_working: true });
    await respond(response(published[0] as AgentTaskEvent, { content: 'Done later.', sends: ['email-send'] }));
    expect((published[1] as AgentTaskEvent).payload.content).toContain('Done later.');
  });

  it('does not forward a result that was spoken on the call', async () => {
    const { bus, published, respond } = liveBus((task) => response(task, { content: 'Quick answer.' }));
    await handler.execute(makeCtx(bus, { brief: 'Quick one', mode: 'now' }));
    await respond(response(published[0] as AgentTaskEvent, { content: 'Quick answer.' }));
    expect(published).toHaveLength(1);
  });

  // Review of #2428: a failed now hand-off said "offer to try again", but the retry hit dedup.
  it('lets the caller retry a now hand-off that failed', async () => {
    const { bus, published } = liveBus((task) => response(task, { content: 'Broke.', isError: true }));
    await handler.execute(makeCtx(bus, { brief: 'Do the thing', mode: 'now' }));
    const retry = await handler.execute(makeCtx(bus, { brief: 'Do the thing', mode: 'now' }));
    expect(retry.success).toBe(true);
    if (retry.success) expect(retry.data).not.toMatchObject({ deduplicated: true });
    expect(published.filter((event) => event.type === 'agent.task')).toHaveLength(2);
  });

  it('answers a repeat of a now hand-off still running without promising a new task', async () => {
    const controller = new AbortController();
    const { bus, published } = liveBus();
    const first = handler.execute(makeCtx(bus, { brief: 'Long job', mode: 'now' }, { inputSignal: controller.signal }));
    await Promise.resolve();
    controller.abort();
    await first;
    const again = await handler.execute(makeCtx(bus, { brief: 'Long job', mode: 'now' }));
    expect(again.success).toBe(true);
    if (again.success) expect(again.data).toMatchObject({ deduplicated: true, still_working: true });
    expect(published).toHaveLength(1);
  });

  // Review of #2428: the reply came back, then the caller hung up before hearing it.
  it('forwards a result whose turn was cancelled before it was spoken', async () => {
    const controller = new AbortController();
    const { bus, published } = liveBus((task) => response(task, { content: 'All finished.' }));
    const result = await handler.execute(makeCtx(bus, { brief: 'Quick one', mode: 'now' }, { inputSignal: controller.signal }));
    expect(result.success && (result.data as { completed?: boolean }).completed).toBe(true);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const forward = published[1] as AgentTaskEvent;
    expect(forward.payload.content).toContain('All finished.');
  });

  // PR #2433 review: a subscriber per hand-off stayed for the life of the process.
  it('subscribes once per bus and holds nothing after hand-offs settle', async () => {
    const { bus, subscriberCount } = liveBus((task) => response(task, { content: 'ok' }));
    for (const brief of ['one', 'two', 'three']) {
      await handler.execute(makeCtx(bus, { brief, mode: 'now' }));
    }
    expect(subscriberCount()).toBe(1);
    expect(pendingReplyCountForTests()).toBe(0);
  });

  // CodeRabbit on PR #2433: a clarification pause is not a result.
  it('returns the coordinator question when it pauses to ask one', async () => {
    const question = JSON.stringify({ _curia_protocol: 'clarification_request', question: 'Which LinkedIn account?', context: 'x', resume_token: 't' });
    const { bus } = liveBus((task) => response(task, { content: question, sends: [] }));
    const result = await handler.execute(makeCtx(bus, { brief: 'Check my feed', mode: 'now' }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({ completed: false, needs_answer: true, question: 'Which LinkedIn account?' });
    expect(JSON.stringify(result.data)).not.toContain('_curia_protocol');
  });

  it('keeps waiting through an execution pause and settles on the final reply', async () => {
    const paused = JSON.stringify({ _curia_protocol: 'execution_paused', done: 1, total: 3, cursor: null, last_slice_units: 1, next: 'slice 2' });
    const { bus, published, respond } = liveBus((task) => response(task, { content: paused }));
    const pending = handler.execute(makeCtx(bus, { brief: 'Long multi-step', mode: 'now' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await respond(response(published[0] as AgentTaskEvent, { content: 'All three done.', sends: [] }));
    const result = await pending;
    expect(result.success && result.data).toMatchObject({ completed: true, result: 'All three done.' });
  });

  it('forwards a late question as a question, not protocol JSON', async () => {
    const controller = new AbortController();
    const { bus, published, respond } = liveBus();
    const first = handler.execute(makeCtx(bus, { brief: 'Long job', mode: 'now' }, { inputSignal: controller.signal }));
    await Promise.resolve();
    controller.abort();
    await first;
    const question = JSON.stringify({ _curia_protocol: 'clarification_request', question: 'Which account?', context: 'x', resume_token: 't' });
    await respond(response(published[0] as AgentTaskEvent, { content: question }));
    const forward = (published[1] as AgentTaskEvent).payload.content;
    expect(forward).toContain('Which account?');
    expect(forward).not.toContain('_curia_protocol');
  });

  // CodeRabbit on PR #2433: a failed forward publish dropped the result.
  it('retries a forward whose publish fails', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { bus, published, respond } = liveBus();
      let failures = 2;
      const realPublish = (bus as unknown as { publishDetached: (l: string, e: BusEvent) => Promise<void> }).publishDetached;
      (bus as unknown as { publishDetached: (l: string, e: BusEvent) => Promise<void> }).publishDetached = async (layer, event) => {
        if (published.length >= 1 && failures > 0) { failures -= 1; throw new Error('write-ahead failed'); }
        await realPublish(layer, event);
      };
      const first = handler.execute(makeCtx(bus, { brief: 'Long job', mode: 'now' }, { inputSignal: controller.signal }));
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await first;
      // The forward waits out its retry delays, so advance time before awaiting it.
      const delivered = respond(response(published[0] as AgentTaskEvent, { content: 'Late result.' }));
      await vi.advanceTimersByTimeAsync(60_000);
      await delivered;
      expect(published).toHaveLength(2);
      expect((published[1] as AgentTaskEvent).payload.content).toContain('Late result.');
    } finally {
      vi.useRealTimers();
    }
  });

  // CodeRabbit round 3 on PR #2433.
  it('returns the clarification context with the question, for the next brief', async () => {
    const question = JSON.stringify({ _curia_protocol: 'clarification_request', question: 'Which account?', context: 'Job created; sign-in pending.', resume_token: 't' });
    const { bus } = liveBus((task) => response(task, { content: question }));
    const result = await handler.execute(makeCtx(bus, { brief: 'Check my feed', mode: 'now' }));
    expect(result.success && result.data).toMatchObject({ needs_answer: true, question: 'Which account?', context: 'Job created; sign-in pending.' });
    if (result.success) expect((result.data as { note: string }).note).toContain('context');
  });

  it('keeps the coordinator text when the work fails, on the call and in a forward', async () => {
    const { bus } = liveBus((task) => response(task, { content: 'Sent the message, then the calendar step failed.', isError: true }));
    const onCall = await handler.execute(makeCtx(bus, { brief: 'Two steps', mode: 'now' }));
    expect(onCall.success && onCall.data).toMatchObject({ failed: true, result: 'Sent the message, then the calendar step failed.' });

    resetAsyncOfframpDedupForTests();
    const controller = new AbortController();
    const late = liveBus();
    const first = handler.execute(makeCtx(late.bus, { brief: 'Two steps later', mode: 'now' }, { inputSignal: controller.signal }));
    await Promise.resolve();
    controller.abort();
    await first;
    await late.respond(response(late.published[0] as AgentTaskEvent, { content: 'Sent it; then a step failed.', isError: true }));
    expect((late.published[1] as AgentTaskEvent).payload.content).toContain('Sent it; then a step failed.');
  });

  it('forwards a late question with its context', async () => {
    const controller = new AbortController();
    const { bus, published, respond } = liveBus();
    const first = handler.execute(makeCtx(bus, { brief: 'Long job', mode: 'now' }, { inputSignal: controller.signal }));
    await Promise.resolve();
    controller.abort();
    await first;
    const question = JSON.stringify({ _curia_protocol: 'clarification_request', question: 'Which account?', context: 'Two of three steps done.', resume_token: 't' });
    await respond(response(published[0] as AgentTaskEvent, { content: question }));
    expect((published[1] as AgentTaskEvent).payload.content).toContain('Two of three steps done.');
  });

  it('keeps the dedup entry while a forward is still retrying', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { bus, published, respond } = liveBus();
      let failures = 1;
      const target = bus as unknown as { publishDetached: (l: string, e: BusEvent) => Promise<void> };
      const realPublish = target.publishDetached;
      target.publishDetached = async (layer, event) => {
        if (published.length >= 1 && failures > 0) { failures -= 1; throw new Error('write-ahead failed'); }
        await realPublish(layer, event);
      };
      const first = handler.execute(makeCtx(bus, { brief: 'Long job', mode: 'now' }, { inputSignal: controller.signal }));
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await first;
      const delivered = respond(response(published[0] as AgentTaskEvent, { content: 'Late result.' }));
      await vi.advanceTimersByTimeAsync(1_000);
      const repeat = await handler.execute(makeCtx(bus, { brief: 'Long job', mode: 'now' }));
      expect(repeat.success && repeat.data).toMatchObject({ deduplicated: true });
      await vi.advanceTimersByTimeAsync(10_000);
      await delivered;
      expect(published.filter((event) => (event as AgentTaskEvent).payload.content.includes('## Brief'))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keys an explicit idempotency_key by mode too', async () => {
    const { bus, published } = liveBus((task) => response(task, { content: 'ok' }));
    await handler.execute(makeCtx(bus, { brief: 'Research it', idempotency_key: 'k1' }));
    const now = await handler.execute(makeCtx(bus, { brief: 'Research it', idempotency_key: 'k1', mode: 'now' }));
    expect(now.success && now.data).toMatchObject({ completed: true });
    expect(published.filter((event) => event.type === 'agent.task')).toHaveLength(2);
  });

  // CodeRabbit round 4 on PR #2433.
  it('answers a repeat of a finished hand-off with its result instead of redoing it', async () => {
    const { bus, published } = liveBus((task) => response(task, { content: 'Message sent.', sends: ['signal-send'] }));
    await handler.execute(makeCtx(bus, { brief: 'Text her', mode: 'now' }));
    const repeat = await handler.execute(makeCtx(bus, { brief: 'Text her', mode: 'now' }));
    expect(repeat.success && repeat.data).toMatchObject({ deduplicated: true, completed: true, result: 'Message sent.', sent: ['signal-send'] });
    expect(published.filter((event) => event.type === 'agent.task')).toHaveLength(1);
  });

  it('answers a repeat with the result after a cut-off reply was forwarded', async () => {
    const controller = new AbortController();
    const { bus, published } = liveBus((task) => response(task, { content: 'Sent it.', sends: ['email-send'] }));
    await handler.execute(makeCtx(bus, { brief: 'Email him', mode: 'now' }, { inputSignal: controller.signal }));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(published).toHaveLength(2);
    const repeat = await handler.execute(makeCtx(bus, { brief: 'Email him', mode: 'now' }));
    expect(repeat.success && repeat.data).toMatchObject({ deduplicated: true, completed: true, sent: ['email-send'] });
    expect(published).toHaveLength(2);
  });

  it('forwards a failed result whose turn was cancelled before it was heard', async () => {
    const controller = new AbortController();
    const { bus, published } = liveBus((task) => response(task, { content: 'Sent, then failed.', isError: true }));
    await handler.execute(makeCtx(bus, { brief: 'Two steps', mode: 'now' }, { inputSignal: controller.signal }));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((published[1] as AgentTaskEvent).payload.content).toContain('Sent, then failed.');
  });

  it('still forwards a reply that arrives hours after the call moved on', async () => {
    vi.useFakeTimers();
    try {
      const { bus, published, respond } = liveBus();
      const pending = handler.execute(makeCtx(bus, { brief: 'Very long job', mode: 'now' }));
      await vi.advanceTimersByTimeAsync(NOW_MODE_WAIT_MS + 1);
      await pending;
      await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
      await respond(response(published[0] as AgentTaskEvent, { content: 'Finally done.' }));
      expect((published[1] as AgentTaskEvent).payload.content).toContain('Finally done.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cannot collide an explicit key across modes', async () => {
    const { bus, published } = liveBus((task) => response(task, { content: 'ok' }));
    await handler.execute(makeCtx(bus, { brief: 'A', idempotency_key: 'x', mode: 'now' }));
    const other = await handler.execute(makeCtx(bus, { brief: 'B', idempotency_key: 'x|now' }));
    expect(other.success && other.data).toMatchObject({ deduplicated: false });
    expect(published.filter((event) => event.type === 'agent.task')).toHaveLength(2);
  });

  // CodeRabbit round 5 on PR #2433: a forward that never publishes must not
  // free a finished result, or a repeat redoes its send.
  it('keeps a finished result when every forward attempt fails', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { bus, published, respond } = liveBus();
      const target = bus as unknown as { publishDetached: (l: string, e: BusEvent) => Promise<void> };
      const realPublish = target.publishDetached;
      target.publishDetached = async (layer, event) => {
        if (published.length >= 1) throw new Error('write-ahead down');
        await realPublish(layer, event);
      };
      const first = handler.execute(makeCtx(bus, { brief: 'Text her', mode: 'now' }, { inputSignal: controller.signal }));
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await first;
      const delivered = respond(response(published[0] as AgentTaskEvent, { content: 'Message sent.', sends: ['signal-send'] }));
      await vi.advanceTimersByTimeAsync(60_000);
      await delivered;
      target.publishDetached = realPublish;
      const repeat = await handler.execute(makeCtx(bus, { brief: 'Text her', mode: 'now' }));
      expect(repeat.success && repeat.data).toMatchObject({ deduplicated: true, completed: true, sent: ['signal-send'] });
      expect(published).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps after_call as the default and rejects an unknown mode', async () => {
    const { bus, published } = liveBus();
    const result = await handler.execute(makeCtx(bus, { brief: 'Research this' }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject({ accepted: true, mode: 'after_call' });
    expect((published[0] as AgentTaskEvent).payload.content).toContain('reach the principal');

    const bad = await handler.execute(makeCtx(bus, { brief: 'x', mode: 'later' }));
    expect(bad.success).toBe(false);
  });

  // #2495: the principal on the call is live while the call waits on the hand-off, and only then.
  describe('live-turn grant (#2495)', () => {
    beforeEach(() => {
      resetLiveTurnGrantsForTests();
    });

    it('carries a live grant on a now hand-off while the call waits, and revokes it when the wait returns', async () => {
      let activeDuringWork: boolean | undefined;
      const { bus, published } = liveBus((task) => {
        activeDuringWork = isLiveTurnGrantActive(task.payload.liveTurnGrantId);
        return response(task, { content: 'Blocked both contacts.' });
      });
      const result = await handler.execute(makeCtx(bus, { brief: 'Block those two spam contacts', mode: 'now' }));
      expect(result.success).toBe(true);
      const task = published[0] as AgentTaskEvent;
      expect(task.payload.liveTurn).toBe(true);
      expect(typeof task.payload.liveTurnGrantId).toBe('string');
      expect(activeDuringWork).toBe(true);
      expect(isLiveTurnGrantActive(task.payload.liveTurnGrantId)).toBe(false);
      expect(activeLiveTurnGrantCountForTests()).toBe(0);
    });

    it('never puts the live turn or the grant in task metadata', async () => {
      const { bus, published } = liveBus((task) => response(task, { content: 'Done.' }));
      await handler.execute(makeCtx(bus, { brief: 'Block that number', mode: 'now' }));
      const metadata = (published[0] as AgentTaskEvent).payload.metadata ?? {};
      expect(JSON.stringify(metadata)).not.toContain('ltg-');
      expect(metadata).not.toHaveProperty('liveTurn');
      expect(metadata).not.toHaveProperty('liveTurnGrantId');
    });

    it('revokes the grant when the caller speaks and the wait ends', async () => {
      const controller = new AbortController();
      const { bus, published } = liveBus();
      const pending = handler.execute(makeCtx(bus, { brief: 'Block them', mode: 'now' }, { inputSignal: controller.signal }));
      await Promise.resolve();
      const grantId = (published[0] as AgentTaskEvent).payload.liveTurnGrantId;
      expect(isLiveTurnGrantActive(grantId)).toBe(true);
      controller.abort();
      await pending;
      expect(isLiveTurnGrantActive(grantId)).toBe(false);
    });

    it('cannot outlive the wait even if the revoke never runs', async () => {
      vi.useFakeTimers();
      try {
        const { bus, published } = liveBus();
        const pending = handler.execute(makeCtx(bus, { brief: 'Slow block', mode: 'now' }));
        await Promise.resolve();
        const grantId = (published[0] as AgentTaskEvent).payload.liveTurnGrantId;
        expect(isLiveTurnGrantActive(grantId)).toBe(true);
        await vi.advanceTimersByTimeAsync(NOW_MODE_WAIT_MS + 1);
        await pending;
        expect(isLiveTurnGrantActive(grantId)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('revokes the grant when the publish fails', async () => {
      const { bus } = makeBus({ failPublish: true });
      const result = await handler.execute(makeCtx(bus, { brief: 'Block them', mode: 'now' }));
      expect(result.success).toBe(false);
      expect(activeLiveTurnGrantCountForTests()).toBe(0);
    });

    it('gives an after_call hand-off no live turn, only a grant id that was never live', async () => {
      const { bus, published } = liveBus();
      await handler.execute(makeCtx(bus, { brief: 'Block them after the call' }));
      const task = published[0] as AgentTaskEvent;
      expect(task.payload.liveTurn).toBeUndefined();
      expect(typeof task.payload.liveTurnGrantId).toBe('string');
      expect(isLiveTurnGrantActive(task.payload.liveTurnGrantId)).toBe(false);
      expect(activeLiveTurnGrantCountForTests()).toBe(0);
    });

    it('issues no live grant for a caller who is not the principal', async () => {
      const { bus, published } = liveBus((task) => response(task, { content: 'Done.' }));
      await handler.execute(makeCtx(bus, { brief: 'Block them', mode: 'now' }, { liveTurn: false }));
      const task = published[0] as AgentTaskEvent;
      expect(task.payload.liveTurn).toBeUndefined();
      expect(isLiveTurnGrantActive(task.payload.liveTurnGrantId)).toBe(false);
    });

    it('does not carry the grant onto the forward task', async () => {
      const controller = new AbortController();
      const { bus, published, respond } = liveBus();
      const pending = handler.execute(makeCtx(bus, { brief: 'Block them', mode: 'now' }, { inputSignal: controller.signal }));
      await Promise.resolve();
      controller.abort();
      await pending;
      await respond(response(published[0] as AgentTaskEvent, { content: 'Blocked.' }));
      const forward = published[1] as AgentTaskEvent;
      expect(forward.payload.liveTurn).toBeUndefined();
      expect(forward.payload.liveTurnGrantId).toBeUndefined();
    });
  });
});
