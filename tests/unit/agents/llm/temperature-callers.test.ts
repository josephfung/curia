// temperature-callers.test.ts — the three temperature:0 callers must reach the
// provider request body (#2038). Provider unit tests cover the builder knobs;
// these wire each caller through AnthropicProvider so a regression that drops
// options.temperature (or stops forwarding it) fails here.
//
// On claude-haiku-5-5, which 400s on any non-default sampling parameter, the
// same callers must send no temperature, and the judges' own llm.call rows
// must record temperature: null (#2077).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicProvider } from '../../../../src/agents/llm/anthropic.js';
import { ModelRegistry } from '../../../../src/agents/llm/model-registry.js';
import { createSilentLogger } from '../../../../src/logger.js';
import { OutboundLlmJudge } from '../../../../src/dispatch/outbound-judge.js';
import { EscalationJudge } from '../../../../src/autonomy/escalation-judge.js';
import { DriftDetector } from '../../../../src/scheduler/drift-detector.js';
import type { EventBus } from '../../../../src/bus/bus.js';
import type { FilterRecipient } from '../../../../src/dispatch/outbound-filter.js';

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate, stream: vi.fn() };
  },
}));

function makeTextResponse(content: string) {
  return {
    id: 'msg_temp_test',
    model: 'claude-haiku-4-5',
    content: [{ type: 'text', text: content }],
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: null },
    stop_reason: 'end_turn',
  };
}

function fakeBus(): EventBus {
  return { publish: vi.fn(async () => undefined) } as unknown as EventBus;
}

/** The temperature on each llm.call event the bus received. */
function llmCallTemperatures(bus: EventBus): unknown[] {
  const publish = bus.publish as unknown as ReturnType<typeof vi.fn>;
  return publish.mock.calls
    .map(([, event]) => event as { type: string; payload: { temperature?: unknown } })
    .filter((event) => event.type === 'llm.call')
    .map((event) => event.payload.temperature);
}

const SAMPLING_KEYS = ['temperature', 'top_p', 'top_k'] as const;

describe('temperature:0 callers reach the provider request (#2038)', () => {
  const logger = createSilentLogger();
  const registry = new ModelRegistry(logger);

  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('outbound judge builds a request with temperature 0', async () => {
    mockCreate.mockResolvedValue(makeTextResponse('{"leak": false, "reason": ""}'));
    const provider = new AnthropicProvider('test-key', logger, registry);
    const judge = new OutboundLlmJudge(
      provider,
      { enabled: true, model: 'claude-haiku-4-5', timeoutMs: 5000, failMode: 'split' },
      fakeBus(),
      logger,
      registry,
    );
    const armin: FilterRecipient = { email: 'armin@external.com', isPrincipal: false };
    const principal: FilterRecipient = { email: 'ceo@example.com', isPrincipal: true };

    await judge.review({
      content: 'To the CEO: backend issues. Armin — Friday works.',
      recipients: [armin, principal],
      principalIncluded: true,
      principalIsSoleRecipient: false,
      conversationId: '',
      channelId: 'email',
    });

    expect(mockCreate.mock.calls[0]![0].temperature).toBe(0);
  });

  it('escalation judge builds a request with temperature 0', async () => {
    mockCreate.mockResolvedValue(makeTextResponse('{"class": "public", "reason": "fine"}'));
    const provider = new AnthropicProvider('test-key', logger, registry);
    const judge = new EscalationJudge(
      provider,
      { enabled: true, model: 'claude-haiku-4-5', timeoutMs: 5000 },
      fakeBus(),
      logger,
      registry,
    );

    await judge.classifyDisclosure({
      content: 'hello',
      recipientTier: 'unknown',
      conversationId: 'c1',
    });

    expect(mockCreate.mock.calls[0]![0].temperature).toBe(0);
  });

  it('drift detector builds a request with temperature 0', async () => {
    mockCreate.mockResolvedValue(
      makeTextResponse('{"drifted":false,"reason":"Aligned.","confidence":"high"}'),
    );
    const provider = new AnthropicProvider('test-key', logger, registry);
    const detector = new DriftDetector(
      provider,
      {
        enabled: true,
        checkEveryNBursts: 1,
        minConfidenceToPause: 'high',
        model: 'claude-haiku-4-5',
      },
      logger,
    );

    await detector.check({
      intentAnchor: 'Research AI safety weekly.',
      taskPayload: { skill: 'web-search' },
      lastRunSummary: null,
    });

    expect(mockCreate.mock.calls[0]![0].temperature).toBe(0);
  });
});

describe('temperature:0 callers on claude-haiku-5-5 send no sampling parameters (#2077)', () => {
  const logger = createSilentLogger();
  const registry = new ModelRegistry(logger);
  const MODEL = 'claude-haiku-5-5';
  const armin: FilterRecipient = { email: 'armin@external.com', isPrincipal: false };
  const principal: FilterRecipient = { email: 'ceo@example.com', isPrincipal: true };

  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('outbound judge omits temperature and its llm.call row records null', async () => {
    mockCreate.mockResolvedValue({ ...makeTextResponse('{"leak": false, "reason": ""}'), model: MODEL });
    const bus = fakeBus();
    const judge = new OutboundLlmJudge(
      new AnthropicProvider('test-key', logger, registry),
      { enabled: true, model: MODEL, timeoutMs: 5000, failMode: 'split' },
      bus,
      logger,
      registry,
    );

    await judge.review({
      content: 'To the CEO: backend issues. Armin — Friday works.',
      recipients: [armin, principal],
      principalIncluded: true,
      principalIsSoleRecipient: false,
      conversationId: '',
      channelId: 'email',
    });

    const request = mockCreate.mock.calls[0]![0];
    for (const key of SAMPLING_KEYS) expect(request).not.toHaveProperty(key);
    // NO_REASONING keeps #2077's thinking-off request (ADR-048 §3).
    expect(request.thinking).toEqual({ type: 'disabled' });
    expect(llmCallTemperatures(bus)).toEqual([null]);
  });

  it('escalation judge omits temperature and its llm.call row records null', async () => {
    mockCreate.mockResolvedValue({ ...makeTextResponse('{"class": "public", "reason": "fine"}'), model: MODEL });
    const bus = fakeBus();
    const judge = new EscalationJudge(
      new AnthropicProvider('test-key', logger, registry),
      { enabled: true, model: MODEL, timeoutMs: 5000 },
      bus,
      logger,
      registry,
    );

    await judge.classifyDisclosure({
      content: 'hello',
      recipientTier: 'unknown',
      conversationId: 'c1',
    });

    const request = mockCreate.mock.calls[0]![0];
    for (const key of SAMPLING_KEYS) expect(request).not.toHaveProperty(key);
    // NO_REASONING keeps #2077's thinking-off request (ADR-048 §3).
    expect(request.thinking).toEqual({ type: 'disabled' });
    expect(llmCallTemperatures(bus)).toEqual([null]);
  });

  it('drift detector omits temperature', async () => {
    mockCreate.mockResolvedValue({
      ...makeTextResponse('{"drifted":false,"reason":"Aligned.","confidence":"high"}'),
      model: MODEL,
    });
    const detector = new DriftDetector(
      new AnthropicProvider('test-key', logger, registry),
      { enabled: true, checkEveryNBursts: 1, minConfidenceToPause: 'high', model: MODEL },
      logger,
    );

    await detector.check({
      intentAnchor: 'Research AI safety weekly.',
      taskPayload: { skill: 'web-search' },
      lastRunSummary: null,
    });

    const request = mockCreate.mock.calls[0]![0];
    for (const key of SAMPLING_KEYS) expect(request).not.toHaveProperty(key);
    // NO_REASONING keeps #2077's thinking-off request (ADR-048 §3).
    expect(request.thinking).toEqual({ type: 'disabled' });
  });
});
