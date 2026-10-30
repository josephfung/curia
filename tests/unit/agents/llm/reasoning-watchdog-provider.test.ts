import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReasoningWatchdogProvider, watchProvider } from '../../../../src/agents/llm/reasoning-watchdog-provider.js';
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
type Step = LLMStreamEvent | { stall: true } | { wait: number };

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
          if ('wait' in step) {
            // Output in progress with no event (e.g. tool-call arguments being written).
            await new Promise<void>((resolve) => setTimeout(resolve, step.wait));
            continue;
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

  it('holds at most one abort listener per pending event and removes each one (no per-event retention)', async () => {
    const add = vi.spyOn(AbortSignal.prototype, 'addEventListener');
    const remove = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
    let watched: AbortSignal | undefined;
    const outstanding = (): number => {
      const count = (spy: typeof add | typeof remove): number =>
        spy.mock.calls.filter((call, i) => spy.mock.contexts[i] === watched && call[0] === 'abort').length;
      return count(add) - count(remove);
    };
    let maxOutstanding = 0;
    const events = 200;
    const inner: LLMProvider = {
      id: 'fake',
      chat: async () => textResponse('unused'),
      stream: async function* (params) {
        watched = params.options?.signal as AbortSignal;
        yield { type: 'request_started', maxTokens: 1_000_000 };
        for (let i = 0; i < events; i++) {
          maxOutstanding = Math.max(maxOutstanding, outstanding());
          yield { type: 'reasoning_delta', text: `r${i} ` };
        }
        yield { type: 'message_end', content: 'done', usage: usage(), provenance };
      },
    };
    try {
      const result = await new ReasoningWatchdogProvider(inner, createSilentLogger()).chat(baseParams());
      expect(result.type).toBe('text');
      expect(watched).toBeDefined();
      // One listener per event in flight, never an accumulating set...
      expect(maxOutstanding).toBeLessThanOrEqual(1);
      // ...and every listener added for an event is gone once the call ends.
      expect(outstanding()).toBe(0);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
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

  describe('acceptsReasoningInForcedAttempt (#2371)', () => {
    const forcedTool: LLMResponse = {
      type: 'tool_use',
      toolCalls: [{ id: 't1', name: 'calendar-create', input: {} }],
      usage: usage(),
      provenance,
    };
    const stoppingSteps: LLMStreamEvent[] = [
      { type: 'request_started', maxTokens: 10 },
      ...reasoning(8),
      { type: 'message_end', content: 'late', usage: usage(), provenance },
    ];

    it('omits the quoted reasoning when the inner provider sets it to false', async () => {
      const inner = fakeProvider({ steps: stoppingSteps, chatResponses: [forcedTool] });
      Object.assign(inner, { acceptsReasoningInForcedAttempt: false });
      await new ReasoningWatchdogProvider(inner, createSilentLogger()).chat(baseParams());

      expect(inner.chatCalls).toHaveLength(1);
      const last = inner.chatCalls[0]!.messages.at(-1)!;
      const content = last.content as string;
      expect(content.startsWith(MARKER)).toBe(true);
      expect(content).toContain('Take your next step now');
      expect(content).not.toContain('<previous_reasoning>');
      expect(content).not.toContain('r0 r1');
    });

    it('includes the reasoning when the property is true', async () => {
      const inner = fakeProvider({ steps: stoppingSteps, chatResponses: [forcedTool] });
      Object.assign(inner, { acceptsReasoningInForcedAttempt: true });
      await new ReasoningWatchdogProvider(inner, createSilentLogger()).chat(baseParams());
      expect(inner.chatCalls[0]!.messages.at(-1)!.content as string).toContain('<previous_reasoning>');
    });

    it('passes the property through from the inner provider', () => {
      const off = fakeProvider({ steps: [] });
      Object.assign(off, { acceptsReasoningInForcedAttempt: false });
      expect(watchProvider(off, createSilentLogger()).acceptsReasoningInForcedAttempt).toBe(false);
      expect(watchProvider(fakeProvider({ steps: [] }), createSilentLogger()).acceptsReasoningInForcedAttempt).toBeUndefined();
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

  it('message_end empty after reasoning is a watchdog stop with trigger "cap", counting its real usage', async () => {
    const stoppedUsage = usage({
      inputTokens: 500,
      outputTokens: 10_000,
      cacheCreationInputTokens: 7,
      cacheReadInputTokens: 40,
      reasoningTokens: 9_990,
    });
    const inner = fakeProvider({
      steps: [
        { type: 'request_started', maxTokens: 10_000 },
        ...reasoning(4),
        { type: 'message_end', content: '', usage: stoppedUsage, provenance },
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
    // The stopped attempt's real usage (not its 4 reasoning deltas) plus the forced attempt's.
    expect(result.usage).toEqual({
      inputTokens: 600,
      outputTokens: 10_020,
      cacheCreationInputTokens: 7,
      cacheReadInputTokens: 40,
      reasoningTokens: 9_990,
    });
  });

  it('an empty message_end with no readable reasoning falls back to inner.chat(params) once, unforced', async () => {
    const emptyUsage = usage({ inputTokens: 300, outputTokens: 4_000, reasoningTokens: 4_000 });
    const inner = fakeProvider({
      steps: [
        { type: 'request_started', maxTokens: 4_000 },
        { type: 'message_end', content: '', usage: emptyUsage, provenance, reasoningOmitted: 'encrypted' },
      ],
      chatResponses: [textResponse('Retried answer.')],
    });
    const params = baseParams({ deadlineAt: Date.now() + 600_000 });
    const result = await new ReasoningWatchdogProvider(inner, createSilentLogger()).chat(params);
    expect(inner.chatCalls).toHaveLength(1);
    // The original params, untouched: no runtime note, deadlineAt kept.
    expect(inner.chatCalls[0]).toBe(params);
    if (result.type !== 'text') throw new Error(`expected text, got ${result.type}`);
    expect(result.content).toBe('Retried answer.');
    expect(result.provenance.reasoningWatchdog).toBeUndefined();
    // The empty attempt was billed too.
    expect(result.usage).toEqual(usage({ inputTokens: 400, outputTokens: 4_020, reasoningTokens: 4_000 }));
  });

  it('stands down on output_started: a long tool-call write past fireAtMs is not cut', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const { fireAtMs } = watchdogLimits({ maxTokens: 10_000, callStartMs: start });
    const toolUse: LLMStreamEvent = {
      type: 'tool_use',
      toolCalls: [{ id: 't1', name: 'email-send', input: { body: 'long' } }],
      usage: usage(),
      provenance,
    };
    const inner = fakeProvider({
      steps: [
        { type: 'request_started', maxTokens: 10_000 },
        ...reasoning(3),
        { type: 'output_started' },
        { wait: fireAtMs - start + 30_000 },
        toolUse,
      ],
    });
    const pending = new ReasoningWatchdogProvider(inner, createSilentLogger()).chat(baseParams());
    await vi.advanceTimersByTimeAsync(fireAtMs - start + 30_000);
    const result = await pending;
    const signal = inner.streamCalls[0]!.options!.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    expect(result.type).toBe('tool_use');
    if (result.type !== 'tool_use') throw new Error('unreachable');
    expect(result.provenance.reasoningWatchdog).toBeUndefined();
    expect(inner.chatCalls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a non-retryable stream error is returned as-is, not resent through chat()', async () => {
    const authError: AgentError = { ...agentError('401 invalid key'), type: 'AUTH_FAILURE', retryable: false };
    const inner = fakeProvider({
      steps: [{ type: 'request_started', maxTokens: 10_000 }, { type: 'error', error: authError }],
      chatResponses: [textResponse('should not be used')],
    });
    const result = await new ReasoningWatchdogProvider(inner, createSilentLogger()).chat(baseParams());
    expect(result).toEqual({ type: 'error', error: authError });
    expect(inner.chatCalls).toHaveLength(0);
  });

  it.each([
    { maxTokens: 32_768, fireAt: 16_384 },
    { maxTokens: 4_000, fireAt: 2_000 },
  ])('token trigger fires at reasoning token $fireAt of a $maxTokens cap', async ({ maxTokens, fireAt }) => {
    // One-character deltas, so the delta count (not the text length) is the larger estimate.
    const shortDeltas: LLMStreamEvent[] = Array.from({ length: fireAt }, () => ({ type: 'reasoning_delta', text: 'r' }));
    const inner = fakeProvider({
      steps: [
        { type: 'request_started', maxTokens },
        ...shortDeltas,
        { type: 'message_end', content: 'never reached', usage: usage(), provenance },
      ],
      chatResponses: [textResponse('ok')],
    });
    const result = await new ReasoningWatchdogProvider(inner, createSilentLogger()).chat(baseParams());
    // request_started + exactly fireAt deltas; the watchdog fires on the last one.
    expect(inner.consumed).toBe(1 + fireAt);
    if (result.type === 'error') throw new Error('unreachable');
    expect(result.provenance.reasoningWatchdog).toMatchObject({ trigger: 'tokens', firedAtReasoningTokens: fireAt });
    expect(inner.chatCalls).toHaveLength(1);
  });

  it('token trigger fires on estimated tokens when few deltas carry long text (#2371)', async () => {
    // maxTokens 100 -> threshold 50. Three 60-char deltas: ceil(120/3)=40 after the 2nd, ceil(180/3)=60 after the 3rd.
    const long = (c: string): LLMStreamEvent => ({ type: 'reasoning_delta', text: c.repeat(60) });
    const inner = fakeProvider({
      steps: [
        { type: 'request_started', maxTokens: 100 },
        long('a'),
        long('b'),
        long('c'),
        long('d'),
        { type: 'message_end', content: 'never reached', usage: usage(), provenance },
      ],
      chatResponses: [textResponse('ok')],
    });
    const result = await new ReasoningWatchdogProvider(inner, createSilentLogger()).chat(baseParams());
    expect(inner.consumed).toBe(1 + 3);
    if (result.type === 'error') throw new Error('unreachable');
    expect(result.provenance.reasoningWatchdog).toMatchObject({ trigger: 'tokens', firedAtReasoningTokens: 60 });
  });

  it('the caller aborting as the watchdog fires: no forced attempt, the caller error is returned', async () => {
    const caller = new AbortController();
    const steps = reasoning(5);
    const inner = fakeProvider({ chatResponses: [textResponse('should not be used')], noStream: true });
    inner.stream = async function* () {
      yield { type: 'request_started', maxTokens: 10 };
      for (let i = 0; i < steps.length; i++) {
        // The barge-in lands in the same tick as the delta that reaches the threshold.
        if (i === steps.length - 1) caller.abort(new Error('barge-in'));
        yield steps[i]!;
      }
      yield { type: 'message_end', content: 'late', usage: usage(), provenance };
    };
    const result = await new ReasoningWatchdogProvider(inner, createSilentLogger()).chat(baseParams({ signal: caller.signal }));
    expect(inner.chatCalls).toHaveLength(0);
    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('unreachable');
    expect(result.error.message).toContain('barge-in');
  });

  it('watchProvider wraps a provider in a ReasoningWatchdogProvider over it', async () => {
    const inner = fakeProvider({ noStream: true, chatResponses: [textResponse('hi')] });
    const wrapped = watchProvider(inner, createSilentLogger());
    expect(wrapped).toBeInstanceOf(ReasoningWatchdogProvider);
    expect(wrapped.id).toBe('fake');
    expect(await wrapped.chat(baseParams())).toEqual(textResponse('hi'));
    expect(inner.chatCalls).toHaveLength(1);
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
