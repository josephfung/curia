// Which case a piece of work belongs to when several run on one stack (#1980).
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../src/bus/bus.js';
import { createAgentTask, createLlmCall, type AgentTaskEvent } from '../../../src/bus/events.js';
import type { LLMProvider, LLMResponse, LLMStreamEvent } from '../../../src/agents/llm/provider.js';
import { createLogger } from '../../../src/logger.js';
import {
  closeAttempt,
  createCaseContext,
  guardProvider,
  meterAgentCalls,
  newAttempt,
  PROVIDER_STALL_MS,
  providerFailure,
  runConcurrently,
  stalledCallMs,
  type CaseAttempt,
} from '../../shared/case-scope.js';
import { UsageLedger } from '../../shared/usage.js';

const tick = (ms = 1): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function llmCall(agentId: string, conversationId: string, costUsd: number) {
  return createLlmCall({
    agentId,
    conversationId,
    requestedModel: 'm',
    actualModel: 'm',
    provider: 'openrouter',
    inputTokens: 100,
    outputTokens: 10,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 40,
    estimatedCostUsd: costUsd,
    latencyMs: 1,
    providerRequestId: 'r',
    promptHash: 'p',
    responseHash: 'h',
    parentEventId: 'task',
  });
}

describe('case context through the bus', () => {
  // A delegated specialist runs in its own conversation, reached only by a bus event the
  // coordinator's turn publishes. Its spend must still land on the coordinator's case.
  it('bills a specialist woken by a published task to the case that published it', async () => {
    const bus = new EventBus(createLogger('error'));
    const context = createCaseContext<CaseAttempt>();
    const unattributed = new UsageLedger();
    meterAgentCalls(bus, context.current, unattributed);
    bus.subscribe('agent.task', 'agent', async (event) => {
      const task = event as AgentTaskEvent;
      await tick(); // the specialist works asynchronously
      await bus.publish('agent', llmCall(task.payload.agentId, task.payload.conversationId, 0.25));
    });

    const caseTurn = async (attempt: CaseAttempt, conversationId: string) => context.run(attempt, async () => {
      await bus.publish('agent', llmCall('coordinator', conversationId, 1));
      await bus.publish('system', createAgentTask({
        agentId: 'calendar', conversationId: `delegate-${conversationId}`, channelId: 'internal',
        senderId: 'coordinator', content: 'list the day', parentEventId: 'd',
      }));
    });
    const a = newAttempt('A');
    const b = newAttempt('B');
    await Promise.all([caseTurn(a, 'conv-a'), caseTurn(b, 'conv-b')]);

    for (const attempt of [a, b]) {
      const usage = attempt.usage.snapshot();
      expect(usage.byAgent['coordinator']!.estimatedCostUsd).toBe(1);
      expect(usage.byAgent['calendar']!.estimatedCostUsd).toBe(0.25);
      expect(usage.total.calls).toBe(2);
      expect(usage.total.cacheReadInputTokens).toBe(80);
    }
    expect(unattributed.snapshot().total.calls).toBe(0);
  });

  it('bills a call that lands after its case closed outside every case, not to a ledger already read', async () => {
    const bus = new EventBus(createLogger('error'));
    const context = createCaseContext<CaseAttempt>();
    const outside = new UsageLedger();
    meterAgentCalls(bus, context.current, outside);
    const attempt = newAttempt('A');
    await context.run(attempt, async () => {
      await bus.publish('agent', llmCall('coordinator', 'conv-a', 1));
      closeAttempt(attempt);
      // A call that was in flight when the case ended, billed afterwards.
      await bus.publish('agent', llmCall('coordinator', 'conv-a', 2));
    });
    expect(attempt.usage.snapshot().total.estimatedCostUsd).toBe(1);
    expect(outside.snapshot().total.estimatedCostUsd).toBe(2);
    expect(attempt.cancelled).toBe(true);
  });

  it('bills a call made outside every case to nobody\'s case', async () => {
    const bus = new EventBus(createLogger('error'));
    const context = createCaseContext<CaseAttempt>();
    const unattributed = new UsageLedger();
    meterAgentCalls(bus, context.current, unattributed);
    await bus.publish('agent', llmCall('system:scoring-pass', 'system', 0.5));
    expect(unattributed.snapshot().total.estimatedCostUsd).toBe(0.5);
  });
});

describe('guardProvider', () => {
  const ok: LLMResponse = {
    type: 'text', content: 'hi',
    usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    provenance: { requestedModel: 'm', actualModel: 'm', providerRequestId: 'r' },
  } as LLMResponse;

  it('refuses a cancelled attempt\'s calls before they reach the provider', async () => {
    const chat = vi.fn(async () => ok);
    const context = createCaseContext<CaseAttempt>();
    const provider = guardProvider({ id: 'openrouter', chat } as LLMProvider, context.current);
    const attempt = newAttempt('Case A');
    attempt.cancelled = true;
    const response = await context.run(attempt, () => provider.chat({ messages: [] }));
    expect(response.type).toBe('error');
    // Non-retryable and not NOT_FOUND: the runtime ends the turn instead of retrying or falling back.
    expect(response.type === 'error' && response.error).toMatchObject({ type: 'BUDGET_EXCEEDED', retryable: false });
    expect(chat).not.toHaveBeenCalled();
  });

  it('measures how long a call in flight has gone without progress, and forgets it once done', async () => {
    let release!: () => void;
    const chat = vi.fn(() => new Promise<LLMResponse>(resolve => { release = () => resolve(ok); }));
    const context = createCaseContext<CaseAttempt>();
    const provider = guardProvider({ id: 'openrouter', chat } as LLMProvider, context.current);
    const attempt = newAttempt('Case A');
    const pending = context.run(attempt, () => provider.chat({ messages: [] }));
    const started = [...attempt.inFlight.values()][0]!;
    expect(stalledCallMs(attempt, started + 95_000)).toBe(95_000);
    release();
    await pending;
    // A slow call that finished says nothing about a later timeout.
    expect(stalledCallMs(attempt, started + 200_000)).toBe(0);
  });

  it('counts a streamed call\'s events as progress', async () => {
    let next!: () => void;
    async function* stream(): AsyncIterable<LLMStreamEvent> {
      yield { type: 'text_delta', text: 'a' };
      await new Promise<void>(resolve => { next = resolve; });
      yield { type: 'text_delta', text: 'b' };
    }
    const context = createCaseContext<CaseAttempt>();
    const provider = guardProvider({ id: 'openrouter', chat: vi.fn(), stream } as unknown as LLMProvider, context.current);
    const attempt = newAttempt('Case A');
    await context.run(attempt, async () => {
      const it = provider.stream!({ messages: [] })[Symbol.asyncIterator]();
      await it.next();
      const progressed = [...attempt.inFlight.values()][0]!;
      expect(stalledCallMs(attempt, progressed + 10)).toBe(10);
      // The generator reaches its pause only once asked for the next event.
      const second = it.next();
      await tick();
      next();
      await second;
      await it.next();
    });
    expect(attempt.inFlight.size).toBe(0);
  });

  it('keeps two providers\' calls in one attempt apart', async () => {
    const releases: Array<() => void> = [];
    const slow = (): LLMProvider => ({ id: 'p', chat: () => new Promise<LLMResponse>(resolve => { releases.push(() => resolve(ok)); }) } as LLMProvider);
    const context = createCaseContext<CaseAttempt>();
    const a = guardProvider(slow(), context.current);
    const b = guardProvider(slow(), context.current);
    const attempt = newAttempt('Case A');
    const calls = context.run(attempt, () => Promise.all([a.chat({ messages: [] }), b.chat({ messages: [] })]));
    expect(attempt.inFlight.size).toBe(2);
    releases[0]!();
    await tick();
    expect(attempt.inFlight.size).toBe(1);
    releases[1]!();
    await calls;
    expect(attempt.inFlight.size).toBe(0);
  });

  it('passes calls outside every attempt (the judge\'s) straight through', async () => {
    const chat = vi.fn(async () => ok);
    const provider = guardProvider({ id: 'openrouter', chat } as LLMProvider, () => undefined);
    expect(await provider.chat({ messages: [] })).toBe(ok);
    expect(provider.stream).toBeUndefined();
  });
});

describe('providerFailure', () => {
  it('blames the provider for a fallback, a provider error type, or a stalled call', () => {
    expect(providerFailure({ kind: 'fallback', stalledCallMs: 0 })).toBe('model fallback');
    expect(providerFailure({ kind: 'agent_error', errorType: 'PROVIDER_ERROR', stalledCallMs: 0 })).toBe('provider error (PROVIDER_ERROR)');
    expect(providerFailure({ kind: 'error_response', errorType: 'RATE_LIMIT', stalledCallMs: 0 })).toBe('provider error (RATE_LIMIT)');
    expect(providerFailure({ kind: 'timeout', stalledCallMs: PROVIDER_STALL_MS + 5_000 }))
      .toBe('provider stall (a model call had made no progress for 95s)');
  });

  it('leaves the model\'s failures to the model', () => {
    // Many quick calls until the timeout: the model looping, not the provider stalling.
    expect(providerFailure({ kind: 'timeout', stalledCallMs: 12_000 })).toBeUndefined();
    expect(providerFailure({ kind: 'timeout', stalledCallMs: PROVIDER_STALL_MS - 1 })).toBeUndefined();
    expect(providerFailure({ kind: 'agent_error', errorType: 'BUDGET_EXCEEDED', stalledCallMs: 0 })).toBeUndefined();
    expect(providerFailure({ kind: 'delivery', stalledCallMs: 0 })).toBeUndefined();
    expect(providerFailure({ stalledCallMs: 0 })).toBeUndefined();
  });
});

describe('runConcurrently', () => {
  it('runs at most `concurrency` at once and keeps input order', async () => {
    let running = 0;
    let peak = 0;
    const results = await runConcurrently([30, 5, 20, 1, 10], 2, async (ms, i) => {
      running++;
      peak = Math.max(peak, running);
      await tick(ms);
      running--;
      return i;
    });
    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it('keeps apart items canStart refuses to overlap', async () => {
    const live = new Set<string>();
    const overlaps: string[] = [];
    await runConcurrently(['x1', 'y', 'x2', 'z'], 4, async (item) => {
      const key = item[0]!;
      if (live.has(key)) overlaps.push(item);
      live.add(key);
      await tick(5);
      live.delete(key);
    }, (item, running) => !running.some(r => r[0] === item[0]));
    expect(overlaps).toEqual([]);
  });

  it('reports a worker error once the rest have finished', async () => {
    const finished: number[] = [];
    await expect(runConcurrently([1, 2, 3], 3, async (n) => {
      await tick(n * 5);
      if (n === 1) throw new Error('boom');
      finished.push(n);
    })).rejects.toThrow('boom');
    expect(finished.sort()).toEqual([2, 3]);
  });

  it('settles when a worker throws synchronously, on the first pump or a later one', async () => {
    const worker = (n: number): Promise<number> => {
      if (n === 3) throw new Error('sync boom'); // not async: throws before returning a promise
      return tick(5).then(() => n);
    };
    // Item 3 starts from a later pump (inside a finally callback), where a stray throw
    // would once have left the run pending forever.
    await expect(runConcurrently([1, 2, 3], 1, worker)).rejects.toThrow('sync boom');
    await expect(runConcurrently([3], 1, worker)).rejects.toThrow('sync boom');
  });

  it('rejects a bad concurrency', async () => {
    await expect(runConcurrently([1], 0, async () => 1)).rejects.toThrow(/positive integer/);
  });
});
