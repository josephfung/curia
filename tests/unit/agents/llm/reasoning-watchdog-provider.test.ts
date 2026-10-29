import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReasoningWatchdogProvider } from '../../../../src/agents/llm/reasoning-watchdog-provider.js';
import { watchdogLimits } from '../../../../src/agents/llm/reasoning-watchdog.js';
import type {
  LLMCallProvenance,
  LLMProvider,
  LLMResponse,
  LLMStreamEvent,
  LLMUsage,
  Message,
} from '../../../../src/agents/llm/provider.js';
import type { AgentError } from '../../../../src/errors/types.js';
import { createSilentLogger } from '../../../../src/logger.js';

type ChatParams = Parameters<LLMProvider['chat']>[0];

const MARKER = '[Runtime note from Curia, not from the principal]';

const usage = (over: Partial<LLMUsage> = {}): LLMUsage => ({
  inputTokens: 100,
  outputTokens: 20,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  ...over,
});

const provenance: LLMCallProvenance = {
  requestedModel: 'test/model',
  actualModel: 'test/model',
  providerRequestId: 'req-1',
};

const agentError = (message: string): AgentError => ({
  type: 'PROVIDER_ERROR',
  source: 'fake',
  message,
  retryable: true,
  context: {},
  timestamp: new Date(0),
});

const textResponse = (content: string): LLMResponse => ({ type: 'text', content, usage: usage(), provenance });

/**
 * One step of a scripted stream: an event to yield, or a stall that waits for the
 * request signal to abort and then yields the provider's cancellation error.
 */
type Step = LLMStreamEvent | { stall: true };

interface FakeProvider extends LLMProvider {
  chatCalls: ChatParams[];
  streamCalls: ChatParams[];
  /** How many scripted steps the stream handed out. */
  consumed: number;
  /** True once the stream generator's finally block ran. */
  closed: boolean;
}

function fakeProvider(opts: {
  steps?: Step[];
  chatResponses?: LLMResponse[];
  noStream?: boolean;
  throwAfter?: number;
}): FakeProvider {
  const chatResponses = [...(opts.chatResponses ?? [])];
  const provider: FakeProvider = {
    id: 'fake',
    chatCalls: [],
    streamCalls: [],
    consumed: 0,
    closed: false,
    chat: async (params) => {
      provider.chatCalls.push(params);
      const next = chatResponses.shift();
      if (!next) throw new Error('fake chat: no scripted response left');
      return next;
    },
  };
  if (!opts.noStream) {
    provider.stream = async function* (params) {
      provider.streamCalls.push(params);
      const signal = params.options?.signal as AbortSignal | undefined;
      try {
        for (const step of opts.steps ?? []) {
          if (opts.throwAfter !== undefined && provider.consumed >= opts.throwAfter) {
            throw new Error('socket hang up');
          }
          provider.consumed += 1;
          if ('stall' in step) {
            await new Promise<void>((resolve) => {
              if (signal?.aborted) return resolve();
              signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            yield { type: 'error', error: agentError('Request was aborted.') };
            return;
          }
          yield step;
        }
      } finally {
        provider.closed = true;
      }
    };
  }
  return provider;
}

const reasoning = (n: number, prefix = 'r'): LLMStreamEvent[] =>
  Array.from({ length: n }, (_, i) => ({ type: 'reasoning_delta', text: `${prefix}${i} ` }));

const baseMessages: Message[] = [{ role: 'user', content: 'Book the dinner.' }];

const baseParams = (options: Record<string, unknown> = {}): ChatParams => ({
  messages: baseMessages,
  model: 'test/model',
  options,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ReasoningWatchdogProvider', () => {
  it('passes chat through untouched when the inner provider has no stream()', async () => {
    const inner = fakeProvider({ noStream: true, chatResponses: [textResponse('hi')] });
    const wrapper = new ReasoningWatchdogProvider(inner, createSilentLogger());
    const params = baseParams({ deadlineAt: 123 });
    const result = await wrapper.chat(params);
    expect(result).toEqual(textResponse('hi'));
    expect(inner.chatCalls).toHaveLength(1);
    expect(inner.chatCalls[0]).toBe(params);
  });

  it('does not add a stream method the inner provider lacks', () => {
    const bare = new ReasoningWatchdogProvider(fakeProvider({ noStream: true }), createSilentLogger());
    expect(bare.stream).toBeUndefined();
    expect('stream' in bare).toBe(false);
    const streaming = new ReasoningWatchdogProvider(fakeProvider({ steps: [] }), createSilentLogger());
    expect(typeof streaming.stream).toBe('function');
    expect(streaming.id).toBe('fake');
  });

  it('passes stream through unchanged', async () => {
    const steps: LLMStreamEvent[] = [
      { type: 'request_started', maxTokens: 10 },
      ...reasoning(8),
      { type: 'message_end', content: 'done', usage: usage(), provenance },
    ];
    const inner = fakeProvider({ steps });
    const wrapper = new ReasoningWatchdogProvider(inner, createSilentLogger());
    const seen: LLMStreamEvent[] = [];
    for await (const event of wrapper.stream!(baseParams())) seen.push(event);
    expect(seen).toEqual(steps);
    expect(inner.chatCalls).toHaveLength(0);
  });

  describe('a watched call that finishes normally returns the same LLMResponse inner.chat would', () => {
    it('maps tool_use to a tool_use response', async () => {
      const toolUse: LLMStreamEvent = {
        type: 'tool_use',
        toolCalls: [{ id: 't1', name: 'calendar-create', input: { at: 'noon' } }],
        content: 'Booking now.',
        reasoningBlocks: [{ type: 'reasoning', provider: 'openrouter', model: 'test/model', data: [{ text: 'x' }] }],
        usage: usage({ reasoningTokens: 2 }),
        provenance,
        reasoning: 'r0 r1 ',
      };
      const inner = fakeProvider({ steps: [{ type: 'request_started', maxTokens: 100 }, ...reasoning(2), toolUse] });
      const result = await new ReasoningWatchdogProvider(inner, createSilentLogger()).chat(baseParams());
      expect(result).toEqual({
        type: 'tool_use',
        toolCalls: [{ id: 't1', name: 'calendar-create', input: { at: 'noon' } }],
        content: 'Booking now.',
        reasoningBlocks: [{ type: 'reasoning', provider: 'openrouter', model: 'test/model', data: [{ text: 'x' }] }],
        usage: usage({ reasoningTokens: 2 }),
        provenance,
        reasoning: 'r0 r1 ',
      });
      expect(result.type !== 'error' && result.provenance.reasoningWatchdog).toBeFalsy();
      expect(inner.chatCalls).toHaveLength(0);
      expect(inner.closed).toBe(true);
    });

    it('maps message_end to a text response', async () => {
      const inner = fakeProvider({
        steps: [
          { type: 'request_started', maxTokens: 100 },
          ...reasoning(1),
          { type: 'text_delta', text: 'Hello' },
          { type: 'message_end', content: 'Hello', usage: usage(), provenance, reasoningOmitted: 'encrypted' },
        ],
      });
      const result = await new ReasoningWatchdogProvider(inner, createSilentLogger()).chat(baseParams());
      expect(result).toEqual({ type: 'text', content: 'Hello', usage: usage(), provenance, reasoningOmitted: 'encrypted' });
      expect(result.type !== 'error' && result.provenance.reasoningWatchdog).toBeFalsy();
      expect(inner.chatCalls).toHaveLength(0);
    });
  });

  it('token trigger: aborts after the threshold and makes one forced attempt', async () => {
    const forced: LLMResponse = {
      type: 'tool_use',
      toolCalls: [{ id: 't1', name: 'calendar-create', input: {} }],
      usage: usage(),
      provenance,
    };
    const inner = fakeProvider({
      steps: [{ type: 'request_started', maxTokens: 10 }, ...reasoning(8), { type: 'message_end', content: 'late', usage: usage(), provenance }],
      chatResponses: [forced],
    });
    const logger = createSilentLogger();
    const warn = vi.spyOn(logger, 'warn');
    const result = await new ReasoningWatchdogProvider(inner, logger).chat(baseParams());

    const signal = inner.streamCalls[0]!.options!.signal as AbortSignal;
    expect(signal.aborted).toBe(true);
    // request_started + 5 deltas, and nothing after the 5th.
    expect(inner.consumed).toBe(6);
    expect(inner.closed).toBe(true);

    expect(inner.chatCalls).toHaveLength(1);
    const forcedMessages = inner.chatCalls[0]!.messages;
    expect(forcedMessages.slice(0, baseMessages.length)).toEqual(baseMessages);
    expect(forcedMessages).toHaveLength(baseMessages.length + 1);
    const last = forcedMessages[forcedMessages.length - 1]!;
    expect(last.role).toBe('user');
    expect(typeof last.content).toBe('string');
    expect((last.content as string).startsWith(MARKER)).toBe(true);
    expect(last.content as string).toContain('r0 r1 r2 r3 r4 ');
    expect(last.content as string).not.toContain('r5');

    if (result.type !== 'tool_use') throw new Error(`expected tool_use, got ${result.type}`);
    expect(result.toolCalls).toEqual(forced.type === 'tool_use' ? forced.toolCalls : []);
    expect(result.provenance.reasoningWatchdog).toMatchObject({ trigger: 'tokens', firedAtReasoningTokens: 5, forcedOutcome: 'acted' });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoningWatchdog: expect.objectContaining({ trigger: 'tokens', forcedOutcome: 'acted' }),
        model: 'test/model',
        provider: 'fake',
      }),
      'Reasoning watchdog fired — forced attempt',
    );
  });

  it('time trigger: a stalled stream is aborted at fireAtMs', async () => {
    vi.useFakeTimers();
    let clock = 1_000_000;
    const now = (): number => clock;
    const inner = fakeProvider({
      steps: [{ type: 'request_started', maxTokens: 10_000 }, ...reasoning(1), { stall: true }],
      chatResponses: [textResponse('Here is the answer.')],
    });
    const wrapper = new ReasoningWatchdogProvider(inner, createSilentLogger(), now);
    const { fireAtMs } = watchdogLimits({ maxTokens: 10_000, callStartMs: clock });

    const pending = wrapper.chat(baseParams());
    await vi.advanceTimersByTimeAsync(fireAtMs - clock - 1);
    const signal = inner.streamCalls[0]!.options!.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    clock = fireAtMs;
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);

    const result = await pending;
    if (result.type === 'error') throw new Error('expected a forced response');
    expect(result.provenance.reasoningWatchdog).toMatchObject({
      trigger: 'time',
      firedAtReasoningTokens: 1,
      firedAfterMs: fireAtMs - 1_000_000,
      forcedOutcome: 'acted',
    });
    expect(inner.chatCalls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('deadlineAt moves fireAtMs', async () => {
    vi.useFakeTimers();
    const start = 5_000_000;
    for (const deadlineAt of [start + 300_000, start + 200_000]) {
      let clock = start;
      const inner = fakeProvider({
        steps: [{ type: 'request_started', maxTokens: 10_000 }, ...reasoning(1), { stall: true }],
        chatResponses: [textResponse('ok')],
      });
      const wrapper = new ReasoningWatchdogProvider(inner, createSilentLogger(), () => clock);
      const { fireAtMs } = watchdogLimits({ maxTokens: 10_000, callStartMs: start, deadlineAt });
      const pending = wrapper.chat(baseParams({ deadlineAt }));
      await vi.advanceTimersByTimeAsync(fireAtMs - start - 1);
      const signal = inner.streamCalls[0]!.options!.signal as AbortSignal;
      expect(signal.aborted).toBe(false);
      clock = fireAtMs;
      await vi.advanceTimersByTimeAsync(1);
      expect(signal.aborted).toBe(true);
      const result = await pending;
      if (result.type === 'error') throw new Error('expected a forced response');
      expect(result.provenance.reasoningWatchdog).toMatchObject({ trigger: 'time', firedAfterMs: fireAtMs - start });
    }
  });

  it('stands down on the first text_delta', async () => {
    vi.useFakeTimers();
    const inner = fakeProvider({
      steps: [
        { type: 'request_started', maxTokens: 10 },
        ...reasoning(2),
        { type: 'text_delta', text: 'Sure, ' },
        ...reasoning(10, 'late'),
        { type: 'text_delta', text: 'done.' },
        { type: 'message_end', content: 'Sure, done.', usage: usage(), provenance },
      ],
    });
    const result = await new ReasoningWatchdogProvider(inner, createSilentLogger()).chat(baseParams());
    const signal = inner.streamCalls[0]!.options!.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    expect(result).toEqual({ type: 'text', content: 'Sure, done.', usage: usage(), provenance });
    expect(inner.chatCalls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a caller abort returns the stream\'s error and never calls inner.chat', async () => {
    const caller = new AbortController();
    const inner = fakeProvider({
      steps: [{ type: 'request_started', maxTokens: 10_000 }, ...reasoning(2), { stall: true }],
      chatResponses: [textResponse('should not be used')],
    });
    const pending = new ReasoningWatchdogProvider(inner, createSilentLogger()).chat(baseParams({ signal: caller.signal }));
    // Let the stream reach the stall, then barge in.
    await vi.waitFor(() => expect(inner.consumed).toBe(4));
    caller.abort();
    const result = await pending;
    expect(result).toEqual({ type: 'error', error: agentError('Request was aborted.') });
    expect(inner.chatCalls).toHaveLength(0);
    expect(inner.closed).toBe(true);
  });

  describe('a stream error falls back to inner.chat(params) once with the original params', () => {
    it('on an error event after reasoning', async () => {
      const inner = fakeProvider({
        steps: [{ type: 'request_started', maxTokens: 10_000 }, ...reasoning(3), { type: 'error', error: agentError('idle timeout') }],
        chatResponses: [textResponse('fallback')],
      });
      const params = baseParams({ deadlineAt: Date.now() + 600_000 });
      const result = await new ReasoningWatchdogProvider(inner, createSilentLogger()).chat(params);
      expect(inner.chatCalls).toHaveLength(1);
      expect(inner.chatCalls[0]).toBe(params);
      expect(result).toEqual(textResponse('fallback'));
      if (result.type === 'error') throw new Error('unreachable');
      expect(result.provenance.reasoningWatchdog).toBeUndefined();
    });

    it('on a thrown iteration error before reasoning', async () => {
      const inner = fakeProvider({
        steps: [{ type: 'request_started', maxTokens: 10_000 }, ...reasoning(3)],
        throwAfter: 1,
        chatResponses: [textResponse('fallback')],
      });
      const params = baseParams();
      const result = await new ReasoningWatchdogProvider(inner, createSilentLogger()).chat(params);
      expect(inner.chatCalls).toHaveLength(1);
      expect(inner.chatCalls[0]).toBe(params);
      expect(result).toEqual(textResponse('fallback'));
    });
  });

  it('message_end empty at the cap is a watchdog stop with trigger "cap"', async () => {
    const inner = fakeProvider({
      steps: [
        { type: 'request_started', maxTokens: 10_000 },
        ...reasoning(4),
        { type: 'message_end', content: '', usage: usage({ outputTokens: 10_000 }), provenance },
      ],
      chatResponses: [textResponse('Acted on it.')],
    });
    const result = await new ReasoningWatchdogProvider(inner, createSilentLogger()).chat(baseParams());
    expect(inner.chatCalls).toHaveLength(1);
    const last = inner.chatCalls[0]!.messages.at(-1)!;
    expect((last.content as string).startsWith(MARKER)).toBe(true);
    if (result.type === 'error') throw new Error('unreachable');
    expect(result.type).toBe('text');
    expect(result.provenance.reasoningWatchdog).toMatchObject({ trigger: 'cap', firedAtReasoningTokens: 4, forcedOutcome: 'acted' });
  });

  it('the forced response comes back empty: forcedOutcome "empty"', async () => {
    const inner = fakeProvider({
      steps: [{ type: 'request_started', maxTokens: 10 }, ...reasoning(6)],
      chatResponses: [textResponse(''), textResponse('never')],
    });
    const result = await new ReasoningWatchdogProvider(inner, createSilentLogger()).chat(baseParams());
    expect(inner.chatCalls).toHaveLength(1);
    if (result.type === 'error') throw new Error('unreachable');
    expect(result.content).toBe('');
    expect(result.provenance.reasoningWatchdog).toMatchObject({ trigger: 'tokens', forcedOutcome: 'empty' });
  });

  it('the forced response is an error: returned as-is, warn logged with forcedOutcome "error"', async () => {
    const forcedError: LLMResponse = { type: 'error', error: agentError('upstream 502') };
    const inner = fakeProvider({
      steps: [{ type: 'request_started', maxTokens: 10 }, ...reasoning(6)],
      chatResponses: [forcedError],
    });
    const logger = createSilentLogger();
    const warn = vi.spyOn(logger, 'warn');
    const result = await new ReasoningWatchdogProvider(inner, logger).chat(baseParams());
    expect(result).toEqual(forcedError);
    expect(inner.chatCalls).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningWatchdog: expect.objectContaining({ trigger: 'tokens', forcedOutcome: 'error' }) }),
      'Reasoning watchdog fired — forced attempt',
    );
  });

  it('usage adds the stopped attempt\'s reasoning-delta count to outputTokens and reasoningTokens', async () => {
    const forced: LLMResponse = { type: 'text', content: 'ok', usage: usage({ outputTokens: 30, reasoningTokens: 7 }), provenance };
    const inner = fakeProvider({
      steps: [{ type: 'request_started', maxTokens: 10 }, ...reasoning(6)],
      chatResponses: [forced],
    });
    const result = await new ReasoningWatchdogProvider(inner, createSilentLogger()).chat(baseParams());
    if (result.type === 'error') throw new Error('unreachable');
    expect(result.usage).toEqual(usage({ inputTokens: 100, outputTokens: 35, reasoningTokens: 12 }));
  });

  it('the forced attempt keeps the caller\'s options (reasoning, max_tokens, model, signal) and drops deadlineAt', async () => {
    const caller = new AbortController();
    const options = {
      reasoning: { effort: 'high' },
      max_tokens: 10,
      signal: caller.signal,
      deadlineAt: Date.now() + 900_000,
    };
    const inner = fakeProvider({
      steps: [{ type: 'request_started', maxTokens: 10 }, ...reasoning(6)],
      chatResponses: [textResponse('ok')],
    });
    await new ReasoningWatchdogProvider(inner, createSilentLogger()).chat({
      messages: baseMessages,
      model: 'test/model',
      tools: [],
      options,
    });
    const forcedCall = inner.chatCalls[0]!;
    expect(forcedCall.model).toBe('test/model');
    expect(forcedCall.tools).toEqual([]);
    expect(forcedCall.options).toEqual({ reasoning: { effort: 'high' }, max_tokens: 10, signal: caller.signal });
    expect(forcedCall.options).not.toHaveProperty('deadlineAt');
    expect(caller.signal.aborted).toBe(false);
  });
});
