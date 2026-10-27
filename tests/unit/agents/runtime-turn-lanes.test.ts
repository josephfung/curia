// Turn-lane wiring (#2018, R-1 through R-8). The flag-off cases spy the lane and
// expect no method calls. The flag-on cases check that one conversation has one
// holder, and that every exit drops it before the next task starts.

import { describe, it, expect, vi, afterEach } from 'vitest';
import pino from 'pino';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import { TurnLanes } from '../../../src/dispatch/turn-lanes.js';
import { EventBus } from '../../../src/bus/bus.js';
import {
  createAgentResponse,
  createAgentTask,
  createInboundMessage,
  createSecretCaptured,
  type AgentResponseEvent,
  type AgentTaskEvent,
  type OutboundMessageEvent,
} from '../../../src/bus/events.js';
import type { LLMProvider, LLMResponse } from '../../../src/agents/llm/provider.js';
import type { ExecutionLayer } from '../../../src/skills/execution.js';
import type { WorkingMemory } from '../../../src/memory/working-memory.js';
import type { TaskRepo } from '../../../src/db/task-repo.js';
import { createLogger } from '../../../src/logger.js';
import { deterministicWakeEventId } from '../../../src/agents/late-delegation.js';
import { SecretCaptureResumeSubscriber } from '../../../src/secrets/secret-capture-resume-subscriber.js';
import { encodeResumeToken } from '../../../src/agents/resume-token.js';
import type { ContactResolver } from '../../../src/contacts/contact-resolver.js';

const USAGE = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const PROVENANCE = {
  requestedModel: 'mock-model',
  actualModel: 'mock-model',
  providerRequestId: 'msg_mock_000',
} as const;

const CONTACT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function text(content: string): LLMResponse {
  return { type: 'text', content, usage: USAGE, provenance: PROVENANCE };
}

function toolUse(name: string, input: Record<string, unknown>): LLMResponse {
  return {
    type: 'tool_use',
    toolCalls: [{ id: `call-${name}`, name, input }],
    content: '',
    usage: USAGE,
    provenance: PROVENANCE,
  };
}

function userText(params: { messages: Array<{ role: string; content: unknown }> }): string {
  const last = [...params.messages].reverse().find((message) => message.role === 'user');
  return typeof last?.content === 'string' ? last.content : '';
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve: (value: T) => void = () => {};
  let reject: (err: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function lanes(enabled: boolean, logger = pino({ level: 'silent' }), timeoutMs = 60_000): TurnLanes {
  return new TurnLanes({
    enabled,
    maxInjectionsPerTurn: 5,
    extraRoundsPerInjection: 2,
    laneWaitTimeoutMs: timeoutMs,
    logger,
  });
}

function task(content: string, overrides: Partial<AgentTaskEvent['payload']> = {}): AgentTaskEvent {
  return createAgentTask({
    agentId: 'coordinator',
    conversationId: 'conv-1',
    channelId: 'email',
    senderId: CONTACT,
    content,
    parentEventId: `parent-${content}`,
    ...overrides,
  });
}

describe('runtime turn lanes (#2018)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('R-1: flag off runs two tasks on one conversation concurrently and calls no lane method', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    const gate = lanes(false);
    const reserve = vi.spyOn(gate, 'reserve');
    const acquire = vi.spyOn(gate, 'acquire');
    const release = vi.spyOn(gate, 'release');
    const isLaned = vi.spyOn(gate, 'isLaned');
    const tryInject = vi.spyOn(gate, 'tryInject');
    const first = deferred<LLMResponse>();
    let calls = 0;
    const provider: LLMProvider = {
      id: 'mock',
      chat: vi.fn((params: { messages: Array<{ role: string; content: unknown }> }) => {
        calls += 1;
        if (userText(params).includes('HOLDER')) return first.promise;
        return Promise.resolve(text('waiter'));
      }),
    };
    new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'x',
      provider,
      resolvedModel: 'mock-model',
      bus,
      logger,
      turnLanes: gate,
    }).register();

    const holder = bus.publish('dispatch', task('HOLDER'));
    await vi.waitFor(() => expect(calls).toBe(1));
    const waiter = bus.publish('dispatch', task('WAITER'));
    await vi.waitFor(() => expect(calls).toBe(2));
    first.resolve(text('holder'));
    await Promise.all([holder, waiter]);

    expect(reserve).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(isLaned).not.toHaveBeenCalled();
    expect(tryInject).not.toHaveBeenCalled();
  });

  it('R-2: a delegated task and a scheduler task do not wait behind a holder', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    const gate = lanes(true);
    const first = deferred<LLMResponse>();
    const seen: string[] = [];
    const provider: LLMProvider = {
      id: 'mock',
      chat: vi.fn((params: { messages: Array<{ role: string; content: unknown }> }) => {
        const body = userText(params);
        seen.push(body);
        if (body.includes('HOLDER')) return first.promise;
        return Promise.resolve(text('ran'));
      }),
    };
    new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'x',
      provider,
      resolvedModel: 'mock-model',
      bus,
      logger,
      turnLanes: gate,
    }).register();

    const holder = bus.publish('dispatch', task('HOLDER'));
    await vi.waitFor(() => expect(seen.some((body) => body.includes('HOLDER'))).toBe(true));
    const delegated = bus.publish('dispatch', task('DELEGATED', {
      metadata: { delegationOrigin: { taskEventId: 'parent-task', conversationId: 'conv-1' } },
    }));
    const scheduled = bus.publish('dispatch', task('SCHEDULED', { channelId: 'scheduler' }));
    await Promise.all([delegated, scheduled]);
    expect(seen.some((body) => body.includes('DELEGATED'))).toBe(true);
    expect(seen.some((body) => body.includes('SCHEDULED'))).toBe(true);
    first.resolve(text('holder'));
    await holder;
  });

  it('serializes two coordinator turns, and the dispatcher stamp survives the runtime acquire', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    const gate = lanes(true);
    const reserve = vi.spyOn(gate, 'reserve');
    const first = deferred<LLMResponse>();
    const seen: string[] = [];
    const provider: LLMProvider = {
      id: 'mock',
      chat: vi.fn((params: { messages: Array<{ role: string; content: unknown }> }) => {
        const body = userText(params);
        seen.push(body);
        if (body.includes('first message')) return first.promise;
        return Promise.resolve(text('second reply'));
      }),
    };
    new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'x',
      provider,
      resolvedModel: 'mock-model',
      bus,
      logger,
      turnLanes: gate,
    }).register();
    const resolver = {
      resolve: async () => ({
        resolved: true,
        contactId: CONTACT,
        displayName: 'New Person',
        role: null,
        systemRole: null,
        tier: 'unknown',
        kind: 'person',
        verified: false,
        kgNodeId: null,
        knowledgeSummary: '',
        authorization: null,
        contactConfidence: 0,
      }),
    } as unknown as ContactResolver;
    new Dispatcher({ bus, logger, contactResolver: resolver, turnLanes: gate }).register();

    const firstTurn = bus.publish('channel', createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'email',
      senderId: 'new@example.com',
      content: 'first message',
    }));
    await vi.waitFor(() => expect(seen.some((body) => body.includes('first message'))).toBe(true));
    const stamp = reserve.mock.calls[0]?.[0];
    expect(stamp?.originatorResolved).toBe(true);
    expect(stamp?.originatorContactId).toBe(CONTACT);
    // The runtime acquire infers "not resolved" for a null role and tier unknown.
    // The dispatcher's stamp is the one that counts.
    expect(gate.tryInject('conv-1', {
      inboundEventId: 'follow',
      senderContactId: CONTACT,
      senderResolved: true,
      autoGenerated: false,
      injectionFindingCount: 0,
      channelId: 'email',
      liveTurn: false,
      content: 'same person',
      originalContent: 'same person',
      receivedAt: '2026-10-24T15:17:00.000Z',
    }).kind).toBe('queued');

    const second = bus.publish('channel', createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'email',
      senderId: 'new@example.com',
      content: 'second message',
    }));
    await Promise.resolve();
    expect(seen.some((body) => body.includes('second message'))).toBe(false);
    first.resolve(text('first reply'));
    await firstTurn;
    await second;
    expect(seen.some((body) => body.includes('second message'))).toBe(true);
  });

  it('an unresolved UUID-shaped sender is not injectable', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    const gate = lanes(true);
    const first = deferred<LLMResponse>();
    const provider: LLMProvider = {
      id: 'mock',
      chat: vi.fn(() => first.promise),
    };
    new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'x',
      provider,
      resolvedModel: 'mock-model',
      bus,
      logger,
      turnLanes: gate,
    }).register();
    const aci = CONTACT;
    const resolver = {
      resolve: async (channel: string, senderId: string) => ({ resolved: false, channel, senderId }),
    } as unknown as ContactResolver;
    new Dispatcher({ bus, logger, contactResolver: resolver, turnLanes: gate }).register();

    const running = bus.publish('channel', createInboundMessage({
      conversationId: 'conv-aci',
      channelId: 'signal',
      senderId: aci,
      content: 'hello',
    }));
    await vi.waitFor(() => expect(provider.chat).toHaveBeenCalled());
    expect(gate.tryInject('conv-aci', {
      inboundEventId: 'follow',
      senderContactId: aci,
      senderResolved: true,
      autoGenerated: false,
      injectionFindingCount: 0,
      channelId: 'signal',
      liveTurn: false,
      content: 'injected?',
      originalContent: 'injected?',
      receivedAt: '2026-10-24T15:17:00.000Z',
    })).toEqual({ kind: 'not_injected', reason: 'ineligible' });
    first.resolve(text('done'));
    await running;
  });

  describe('R-4: every exit releases, and the waiter then starts', () => {
    async function holderThenWaiter(opts: {
      provider: LLMProvider;
      executionLayer?: ExecutionLayer;
      errorBudget?: { maxTurns: number; maxConsecutiveErrors: number };
    }): Promise<{ responses: AgentResponseEvent[] }> {
      const logger = createLogger('error');
      const bus = new EventBus(logger);
      const responses: AgentResponseEvent[] = [];
      bus.subscribe('agent.response', 'dispatch', (event) => {
        responses.push(event as AgentResponseEvent);
      });
      const seen: string[] = [];
      const release = deferred<void>();
      const wrapping = opts.provider;
      const provider: LLMProvider = {
        id: 'mock',
        chat: async (params) => {
          const body = userText(params as { messages: Array<{ role: string; content: unknown }> });
          seen.push(body);
          if (body.includes('HOLDER')) await release.promise;
          return wrapping.chat(params);
        },
      };
      new AgentRuntime({
        agentId: 'coordinator',
        systemPrompt: 'x',
        provider,
        resolvedModel: 'mock-model',
        bus,
        logger,
        turnLanes: lanes(true),
        executionLayer: opts.executionLayer,
        errorBudget: opts.errorBudget,
        skillToolDefs: opts.executionLayer
          ? [
              { name: 'request-clarification', description: 'ask', input_schema: { type: 'object', properties: {}, required: [] } },
              { name: 'delegate', description: 'delegate', input_schema: { type: 'object', properties: {}, required: [] } },
              { name: 'web-fetch', description: 'fetch', input_schema: { type: 'object', properties: {}, required: [] } },
            ]
          : undefined,
      }).register();

      const holder = bus.publish('dispatch', task('HOLDER'));
      await vi.waitFor(() => expect(seen.some((body) => body.includes('HOLDER'))).toBe(true));
      const waiter = bus.publish('dispatch', task('WAITER'));
      await Promise.resolve();
      expect(seen.some((body) => body.includes('WAITER'))).toBe(false);
      release.resolve();
      await holder;
      await waiter;
      expect(seen.some((body) => body.includes('WAITER'))).toBe(true);
      return { responses };
    }

    it('normal reply', async () => {
      const { responses } = await holderThenWaiter({
        provider: {
          id: 'mock',
          chat: (params) => Promise.resolve(text(userText(params as { messages: Array<{ role: string; content: unknown }> }).includes('WAITER') ? 'waiter' : 'holder-done')),
        },
      });
      expect(responses.map((event) => event.payload.content)).toContain('holder-done');
    });

    it('clarification', async () => {
      const { responses } = await holderThenWaiter({
        executionLayer: {
          invoke: vi.fn(async (name: string) => {
            if (name !== 'request-clarification') return { success: true, data: {} };
            return { success: true, data: { _curia_protocol: 'clarification_request', question: 'Which day?', context: 'scheduling' } };
          }),
          provenanceSourceText: () => undefined,
        } as unknown as ExecutionLayer,
        provider: {
          id: 'mock',
          chat: (params) => {
            const body = userText(params as { messages: Array<{ role: string; content: unknown }> });
            if (body.includes('WAITER')) return Promise.resolve(text('waiter'));
            return Promise.resolve(toolUse('request-clarification', {}));
          },
        },
      });
      const holderReply = responses.find((event) => event.payload.content.includes('clarification_request'));
      expect(holderReply).toBeDefined();
    });

    it('delegation-failure escalation', async () => {
      const invoke = vi.fn(async (name: string) => {
        if (name === 'task-create') return { success: true, data: { id: 'review-1' } };
        return {
          success: true,
          data: { failed: true, agent: 'researcher', retryable: false, reason: 'agent_error', message: 'specialist broke' },
        };
      });
      const { responses } = await holderThenWaiter({
        executionLayer: {
          invoke,
          provenanceSourceText: () => undefined,
        } as unknown as ExecutionLayer,
        provider: {
          id: 'mock',
          chat: (params) => {
            const body = userText(params as { messages: Array<{ role: string; content: unknown }> });
            if (body.includes('WAITER')) return Promise.resolve(text('waiter'));
            if (body.includes('HOLDER')) return Promise.resolve(toolUse('delegate', { agent: 'researcher', task: 'look it up' }));
            return Promise.resolve(text('Could not finish that.'));
          },
        },
      });
      expect(invoke.mock.calls.map((call) => call[0])).toEqual(['delegate', 'task-create']);
      const holderReply = responses.find((event) => event.payload.content !== 'waiter');
      expect(holderReply?.payload.isError).not.toBe(true);
      expect(holderReply?.payload.content.length).toBeGreaterThan(0);
    });

    it('maxTurns', async () => {
      const { responses } = await holderThenWaiter({
        errorBudget: { maxTurns: 1, maxConsecutiveErrors: 10 },
        executionLayer: {
          invoke: vi.fn(async () => ({ success: true, data: {} })),
          provenanceSourceText: () => undefined,
        } as unknown as ExecutionLayer,
        provider: {
          id: 'mock',
          chat: (params) => {
            const body = userText(params as { messages: Array<{ role: string; content: unknown }> });
            if (body.includes('WAITER')) return Promise.resolve(text('waiter'));
            return Promise.resolve(toolUse('web-fetch', { url: 'https://example.com' }));
          },
        },
      });
      const budget = responses.find((event) => event.payload.errorType === 'BUDGET_EXCEEDED');
      expect(budget?.payload.reason).toBe('maxTurns');
    });

    it('maxConsecutiveErrors', async () => {
      const { responses } = await holderThenWaiter({
        errorBudget: { maxTurns: 10, maxConsecutiveErrors: 1 },
        executionLayer: {
          invoke: vi.fn(async () => ({ success: false, error: 'nope' })),
          provenanceSourceText: () => undefined,
        } as unknown as ExecutionLayer,
        provider: {
          id: 'mock',
          chat: (params) => {
            const body = userText(params as { messages: Array<{ role: string; content: unknown }> });
            if (body.includes('WAITER')) return Promise.resolve(text('waiter'));
            return Promise.resolve(toolUse('web-fetch', { url: 'https://example.com' }));
          },
        },
      });
      const budget = responses.find((event) => event.payload.reason === 'maxConsecutiveErrors');
      expect(budget?.payload.errorType).toBe('BUDGET_EXCEEDED');
    });

    it('a thrown error', async () => {
      const hang = deferred<never>();
      let historyCalls = 0;
      const memory = {
        getHistory: vi.fn(() => {
          historyCalls += 1;
          return historyCalls === 1 ? hang.promise : Promise.resolve([]);
        }),
        addTurn: vi.fn(async () => undefined),
      } as unknown as WorkingMemory;
      const logger = createLogger('error');
      const bus = new EventBus(logger);
      const responses: AgentResponseEvent[] = [];
      bus.subscribe('agent.response', 'dispatch', (event) => {
        responses.push(event as AgentResponseEvent);
      });
      const seen: string[] = [];
      new AgentRuntime({
        agentId: 'coordinator',
        systemPrompt: 'x',
        provider: {
          id: 'mock',
          chat: (params) => {
            seen.push(userText(params as { messages: Array<{ role: string; content: unknown }> }));
            return Promise.resolve(text('waiter'));
          },
        },
        resolvedModel: 'mock-model',
        bus,
        logger,
        turnLanes: lanes(true),
        memory,
      }).register();

      const holder = bus.publish('dispatch', task('HOLDER'));
      await vi.waitFor(() => expect(memory.getHistory).toHaveBeenCalled());
      const waiter = bus.publish('dispatch', task('WAITER'));
      await Promise.resolve();
      expect(seen).toEqual([]);
      hang.reject(new Error('memory down'));
      await holder;
      await waiter;
      expect(seen.some((body) => body.includes('WAITER'))).toBe(true);
      expect(responses.some((event) => event.payload.isError === true)).toBe(true);
    });

    it('llm failure', async () => {
      const { responses } = await holderThenWaiter({
        provider: {
          id: 'mock',
          chat: (params) => {
            const body = userText(params as { messages: Array<{ role: string; content: unknown }> });
            if (body.includes('WAITER')) return Promise.resolve(text('waiter'));
            return Promise.resolve({
              type: 'error',
              error: {
                type: 'AUTH_FAILURE',
                source: 'mock',
                message: 'bad key',
                retryable: false,
                context: {},
                timestamp: new Date(),
              },
            });
          },
        },
      });
      const failed = responses.find((event) => event.payload.errorType === 'AUTH_FAILURE');
      expect(failed?.payload.isError).toBe(true);
    });
  });

  it('R-5: a late wake waits, then runs once; a duplicate id is rejected before delivery', async () => {
    const logger = createLogger('error');
    const seenIds = new Set<string>();
    const bus = new EventBus(logger, async (event) => {
      if (seenIds.has(event.id)) {
        const err = new Error('duplicate audit id') as Error & { code: string };
        err.code = '23505';
        throw err;
      }
      seenIds.add(event.id);
    });
    const first = deferred<LLMResponse>();
    const seen: string[] = [];
    const provider: LLMProvider = {
      id: 'mock',
      chat: vi.fn((params: { messages: Array<{ role: string; content: unknown }> }) => {
        const body = userText(params);
        seen.push(body);
        if (body.includes('HOLDER')) return first.promise;
        return Promise.resolve(text('woke'));
      }),
    };
    new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'x',
      provider,
      resolvedModel: 'mock-model',
      bus,
      logger,
      turnLanes: lanes(true),
    }).register();

    const holder = bus.publish('dispatch', task('HOLDER'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    const wake = task('WAKE the late result', {
      syntheticTurn: true,
      metadata: {
        originator: {
          contactId: CONTACT,
          systemRole: 'principal',
          channel: 'email',
          initiatedAt: 't',
          tier: 'principal',
        },
        wakeContext: { derived: true },
      },
    });
    wake.id = deterministicWakeEventId('delegate-event-1');
    const firstWake = bus.publish('system', wake);
    await Promise.resolve();
    expect(seen).toHaveLength(1);
    await expect(bus.publish('system', wake)).rejects.toMatchObject({ code: '23505' });
    expect(seen).toHaveLength(1);

    first.resolve(text('holder'));
    await holder;
    await firstWake;
    expect(seen.filter((body) => body.includes('WAKE'))).toHaveLength(1);
  });

  it('R-6: a waited retry wake still trips the delegation retry cap', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    const createTask = vi.fn(async () => ({ id: 'queued-1' }));
    const first = deferred<LLMResponse>();
    const provider: LLMProvider = {
      id: 'mock',
      chat: vi.fn((params: { messages: Array<{ role: string; content: unknown }> }) => {
        const body = userText(params);
        if (body.includes('HOLDER')) return first.promise;
        if (body.includes('WAITER')) return Promise.resolve(text('waiter'));
        if (body.includes('RETRY')) return Promise.resolve(toolUse('delegate', { agent: 'researcher', task: 'do the thing' }));
        return Promise.resolve(text('done'));
      }),
    };
    new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'x',
      provider,
      resolvedModel: 'mock-model',
      bus,
      logger,
      turnLanes: lanes(true),
      taskRepo: { createTask } as unknown as TaskRepo,
      executionLayer: {
        invoke: vi.fn(async () => ({
          success: true,
          data: { in_flight: true, reason: 'already_in_flight', agent: 'researcher' },
        })),
        provenanceSourceText: () => undefined,
      } as unknown as ExecutionLayer,
      skillToolDefs: [
        { name: 'delegate', description: 'delegate', input_schema: { type: 'object', properties: {}, required: [] } },
      ],
    }).register();

    const holder = bus.publish('dispatch', task('HOLDER'));
    await vi.waitFor(() => expect(provider.chat).toHaveBeenCalledTimes(1));
    const retry = bus.publish('dispatch', task('RETRY this brief', {
      metadata: { delegationRetry: { attempt: 3, targetAgent: 'researcher' } },
    }));
    await Promise.resolve();
    expect(provider.chat).toHaveBeenCalledTimes(1);
    first.resolve(text('holder'));
    await holder;
    await retry;
    expect(createTask).not.toHaveBeenCalled();
  });

  it('R-6: with the flag off the same cap still trips', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    const gate = lanes(false);
    const acquire = vi.spyOn(gate, 'acquire');
    const createTask = vi.fn(async () => ({ id: 'queued-1' }));
    new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'x',
      provider: {
        id: 'mock',
        chat: () => Promise.resolve(toolUse('delegate', { agent: 'researcher', task: 'do the thing' })),
      },
      resolvedModel: 'mock-model',
      bus,
      logger,
      turnLanes: gate,
      errorBudget: { maxTurns: 2, maxConsecutiveErrors: 5 },
      taskRepo: { createTask } as unknown as TaskRepo,
      executionLayer: {
        invoke: vi.fn(async () => ({
          success: true,
          data: { in_flight: true, reason: 'already_in_flight', agent: 'researcher' },
        })),
        provenanceSourceText: () => undefined,
      } as unknown as ExecutionLayer,
      skillToolDefs: [
        { name: 'delegate', description: 'delegate', input_schema: { type: 'object', properties: {}, required: [] } },
      ],
    }).register();

    await bus.publish('dispatch', task('RETRY', {
      metadata: { delegationRetry: { attempt: 3, targetAgent: 'researcher' } },
    }));
    expect(createTask).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it('R-7: a secret-capture resume waits, then runs with the token, and its routing is consumed', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    const outbound: OutboundMessageEvent[] = [];
    const first = deferred<LLMResponse>();
    const seen: string[] = [];
    const responses: AgentResponseEvent[] = [];
    bus.subscribe('agent.response', 'system', (event) => {
      responses.push(event as AgentResponseEvent);
    });
    const provider: LLMProvider = {
      id: 'mock',
      chat: vi.fn((params: { messages: Array<{ role: string; content: unknown }> }) => {
        const body = userText(params);
        seen.push(body);
        if (body.includes('HOLDER')) return first.promise;
        return Promise.resolve(text('resumed'));
      }),
    };
    new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'x',
      provider,
      resolvedModel: 'mock-model',
      bus,
      logger,
      turnLanes: lanes(true),
    }).register();
    const dispatcher = new Dispatcher({ bus, logger });
    dispatcher.register();
    bus.subscribe('outbound.message', 'channel', (event) => {
      outbound.push(event as OutboundMessageEvent);
    });
    new SecretCaptureResumeSubscriber(
      bus,
      logger,
      (taskEventId, routing) => dispatcher.registerExternalTaskRouting(taskEventId, routing),
    ).start();

    const holder = bus.publish('dispatch', task('HOLDER'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const token = encodeResumeToken({ agent: 'researcher', originalTask: 'check the balance', context: 'paused' });
    const captured = bus.publish('system', createSecretCaptured({
      secretName: 'user.aeroplan_password',
      label: 'Aeroplan password',
      conversationId: 'conv-1',
      agentId: 'coordinator',
      channelId: 'email',
      taskEventId: 'task-evt-9',
      resumeToken: token,
      originator: {
        contactId: CONTACT,
        systemRole: 'principal',
        channel: 'email',
        initiatedAt: 't',
        tier: 'principal',
      },
    }, 'task-evt-9'));
    await Promise.resolve();
    expect(seen).toHaveLength(1);

    first.resolve(text('holder'));
    await holder;
    await captured;
    expect(seen.filter((body) => body.includes(token))).toHaveLength(1);
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.payload.content).toBe('resumed');
    const resumeTaskId = responses.find((event) => event.payload.content === 'resumed')?.parentEventId;
    if (typeof resumeTaskId !== 'string') throw new Error('resume task id missing');
    await bus.publish('agent', createAgentResponse({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      content: 'a second copy',
      parentEventId: resumeTaskId,
    }));
    expect(outbound).toHaveLength(1);
  });

  it('R-8: a holder that never releases does not block the waiter past the timeout', async () => {
    vi.useFakeTimers();
    const logger = pino({ level: 'silent' });
    const error = vi.spyOn(logger, 'error');
    const bus = new EventBus(logger);
    const hang = deferred<LLMResponse>();
    const seen: string[] = [];
    new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'x',
      provider: {
        id: 'mock',
        chat: (params) => {
          const body = userText(params as { messages: Array<{ role: string; content: unknown }> });
          seen.push(body);
          if (body.includes('HOLDER')) return hang.promise;
          return Promise.resolve(text('waiter'));
        },
      },
      resolvedModel: 'mock-model',
      bus,
      logger,
      turnLanes: lanes(true, logger, 60_000),
    }).register();

    const holder = bus.publish('dispatch', task('HOLDER'));
    for (let i = 0; i < 50 && seen.length === 0; i += 1) await vi.advanceTimersByTimeAsync(0);
    expect(seen.some((body) => body.includes('HOLDER'))).toBe(true);
    const waiter = bus.publish('dispatch', task('WAITER'));
    for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(0);
    expect(seen.some((body) => body.includes('WAITER'))).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    await waiter;
    expect(seen.some((body) => body.includes('WAITER'))).toBe(true);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', waitedMs: 60_000 }),
      expect.stringContaining('timed out'),
    );
    hang.resolve(text('holder'));
    await holder;
  });

  it('a follow-up drained at turn start leaves the later delegate waiting (#2018)', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    const gate = lanes(true);
    let releasePersist: () => void = () => {};
    const persistGate = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    let adds = 0;
    const memory = {
      getHistory: vi.fn(async () => []),
      addTurn: vi.fn(async () => {
        adds += 1;
        if (adds === 1) await persistGate;
      }),
    } as unknown as WorkingMemory;
    const prompts: string[] = [];
    let round = 0;
    const provider: LLMProvider = {
      id: 'mock',
      chat: vi.fn(async (params: { messages: Array<{ role: string; content: unknown }> }) => {
        prompts.push(JSON.stringify(params.messages));
        round += 1;
        if (round === 1) return toolUse('delegate', { agent: 'researcher', task: 'look it up' });
        return text('noted');
      }),
    };
    const specialist = deferred<void>();
    let settledHow: 'waiting' | 'aborted' | 'answered' | undefined;
    const signals: Array<AbortSignal | undefined> = [];
    const execution = {
      invoke: vi.fn(async (name: string, _input: unknown, _caller: unknown, options?: { inputSignal?: AbortSignal }) => {
        if (name !== 'delegate') return { success: true, data: {} };
        const signal = options?.inputSignal;
        signals.push(signal);
        if (signal?.aborted) {
          settledHow = 'aborted';
          return {
            success: true,
            data: {
              agent: 'researcher',
              in_progress: true,
              reason: 'interrupted',
              delegate_event_id: 'delegate-sticky',
              delegate_conversation_id: 'delegate-conv-sticky',
              message: 'interrupted',
            },
          };
        }
        settledHow = 'waiting';
        await specialist.promise;
        settledHow = 'answered';
        return { success: true, data: { agent: 'researcher', response: 'found it' } };
      }),
      getToolDefinitions: vi.fn(() => []),
    } as unknown as ExecutionLayer;
    new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'x',
      provider,
      resolvedModel: 'mock-model',
      bus,
      logger,
      memory,
      turnLanes: gate,
      executionLayer: execution,
      skillToolDefs: [
        { name: 'delegate', description: 'delegate', input_schema: { type: 'object', properties: {}, required: [] } },
      ],
    }).register();

    const host = task('start the lookup', {
      metadata: {
        originator: {
          contactId: CONTACT,
          systemRole: 'principal',
          channel: 'email',
          tier: 'principal',
          initiatedAt: '2026-10-24T15:00:00.000Z',
        },
      },
    });
    const running = bus.publish('dispatch', host);
    await vi.waitFor(() => expect(adds).toBe(1));
    expect(gate.tryInject('conv-1', {
      inboundEventId: 'follow-annex',
      senderContactId: CONTACT,
      senderResolved: true,
      autoGenerated: false,
      injectionFindingCount: 0,
      channelId: 'email',
      liveTurn: false,
      content: 'also check the annex',
      originalContent: 'also check the annex',
      receivedAt: '2026-10-24T15:17:00.000Z',
    }).kind).toBe('queued');
    expect(gate.inputSignal(host.id).aborted).toBe(true);
    releasePersist();
    await vi.waitFor(() => expect(settledHow).toBe('waiting'));
    expect(signals[0]?.aborted).toBe(false);
    expect(gate.inputSignal(host.id).aborted).toBe(false);
    expect(prompts[0]).toContain('also check the annex');
    specialist.resolve();
    await running;
    expect(settledHow).toBe('answered');
  });
});
