import { describe, it, expect, vi } from 'vitest';
import { OutboundLlmJudge } from '../../../src/dispatch/outbound-judge.js';
import type { JudgeConfig } from '../../../src/dispatch/outbound-judge.js';
import type { LLMProvider, LLMResponse } from '../../../src/agents/llm/provider.js';
import type { FilterRecipient } from '../../../src/dispatch/outbound-filter.js';
import { ModelRegistry } from '../../../src/agents/llm/model-registry.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { Logger } from '../../../src/logger.js';

const silentLogger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), trace: vi.fn(),
  child: () => silentLogger,
} as unknown as Logger;

function fakeBus(): EventBus & { published: unknown[] } {
  const published: unknown[] = [];
  return { published, publish: vi.fn(async (_topic: string, ev: unknown) => { published.push(ev); }) } as unknown as EventBus & { published: unknown[] };
}

function textResponse(content: string): LLMResponse {
  return {
    type: 'text',
    content,
    usage: { inputTokens: 100, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    provenance: { requestedModel: 'claude-haiku-4-5', actualModel: 'claude-haiku-4-5', providerRequestId: 'msg_test' },
  };
}

function providerReturning(response: LLMResponse | Promise<LLMResponse>): LLMProvider {
  return { id: 'fake', chat: vi.fn(async () => response) } as unknown as LLMProvider;
}

const DEFAULT_CONFIG: JudgeConfig = { enabled: true, model: 'claude-haiku-4-5', timeoutMs: 5000, failMode: 'split' };

function makeJudge(provider: LLMProvider, config: Partial<JudgeConfig> = {}, bus = fakeBus()) {
  const registry = new ModelRegistry(silentLogger);
  const judge = new OutboundLlmJudge(provider, { ...DEFAULT_CONFIG, ...config }, bus, silentLogger, registry);
  return { judge, bus };
}

const armin: FilterRecipient = { email: 'armin@external.com', isPrincipal: false };
const principal: FilterRecipient = { email: 'ceo@example.com', isPrincipal: true };

const MIXED_INPUT = {
  content: 'To the CEO: backend issues. Armin — Friday 2 PM works.',
  recipients: [armin, principal],
  principalIncluded: true,
  principalIsSoleRecipient: false,
  conversationId: '',
  channelId: 'email',
};

describe('OutboundLlmJudge', () => {
  it('returns a finding when the judge reports leak=true', async () => {
    const { judge } = makeJudge(providerReturning(textResponse('{"leak": true, "reason": "side-channel note to the CEO"}')));
    const findings = await judge.review(MIXED_INPUT);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('llm-judge-audience-leak');
    expect(findings[0]!.detail).toContain('side-channel');
  });

  it('returns [] when the judge reports leak=false', async () => {
    const { judge } = makeJudge(providerReturning(textResponse('{"leak": false, "reason": ""}')));
    const findings = await judge.review(MIXED_INPUT);
    expect(findings).toEqual([]);
  });

  it('tolerates a verdict wrapped in markdown code fences', async () => {
    const { judge } = makeJudge(providerReturning(textResponse('```json\n{"leak": true, "reason": "x"}\n```')));
    const findings = await judge.review(MIXED_INPUT);
    expect(findings[0]?.rule).toBe('llm-judge-audience-leak');
  });

  it('skips the LLM call when the principal is the sole recipient', async () => {
    const provider = providerReturning(textResponse('{"leak": true, "reason": "should not run"}'));
    const { judge } = makeJudge(provider);
    const findings = await judge.review({
      content: 'internal status for the CEO only',
      recipients: [principal],
      principalIncluded: true,
      principalIsSoleRecipient: true,
      conversationId: '', channelId: 'email',
    });
    expect(findings).toEqual([]);
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('skips the LLM call when disabled', async () => {
    const provider = providerReturning(textResponse('{"leak": true, "reason": "x"}'));
    const { judge } = makeJudge(provider, { enabled: false });
    const findings = await judge.review(MIXED_INPUT);
    expect(findings).toEqual([]);
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('runs the judge when the principal is included but third parties are too', async () => {
    const provider = providerReturning(textResponse('{"leak": false, "reason": ""}'));
    const { judge } = makeJudge(provider);
    await judge.review(MIXED_INPUT);
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  describe('failMode on timeout/unreachable', () => {
    const slowProvider = () => ({
      id: 'slow',
      chat: vi.fn(() => new Promise<LLMResponse>((resolve) => setTimeout(() => resolve(textResponse('{"leak": true, "reason": "late"}')), 50))),
    }) as unknown as LLMProvider;

    it('split → delivers ([]) on timeout', async () => {
      const { judge } = makeJudge(slowProvider(), { failMode: 'split', timeoutMs: 5 });
      expect(await judge.review(MIXED_INPUT)).toEqual([]);
    });

    it('open → delivers ([]) on timeout', async () => {
      const { judge } = makeJudge(slowProvider(), { failMode: 'open', timeoutMs: 5 });
      expect(await judge.review(MIXED_INPUT)).toEqual([]);
    });

    it('closed → blocks with llm-judge-unavailable on timeout', async () => {
      const { judge } = makeJudge(slowProvider(), { failMode: 'closed', timeoutMs: 5 });
      const findings = await judge.review(MIXED_INPUT);
      expect(findings[0]?.rule).toBe('llm-judge-unavailable');
    });
  });

  describe('failMode on API error', () => {
    const errorResponse: LLMResponse = { type: 'error', error: { message: 'boom' } as never };
    it('split → delivers ([]) on provider error', async () => {
      const { judge } = makeJudge(providerReturning(errorResponse), { failMode: 'split' });
      expect(await judge.review(MIXED_INPUT)).toEqual([]);
    });
    it('closed → blocks on provider error', async () => {
      const { judge } = makeJudge(providerReturning(errorResponse), { failMode: 'closed' });
      expect((await judge.review(MIXED_INPUT))[0]?.rule).toBe('llm-judge-unavailable');
    });
  });

  describe('failMode on malformed verdict', () => {
    it('split → blocks with llm-judge-parse-error', async () => {
      const { judge } = makeJudge(providerReturning(textResponse('not json at all')), { failMode: 'split' });
      expect((await judge.review(MIXED_INPUT))[0]?.rule).toBe('llm-judge-parse-error');
    });
    it('closed → blocks with llm-judge-parse-error', async () => {
      const { judge } = makeJudge(providerReturning(textResponse('not json')), { failMode: 'closed' });
      expect((await judge.review(MIXED_INPUT))[0]?.rule).toBe('llm-judge-parse-error');
    });
    it('open → delivers ([]) on malformed verdict', async () => {
      const { judge } = makeJudge(providerReturning(textResponse('not json')), { failMode: 'open' });
      expect(await judge.review(MIXED_INPUT)).toEqual([]);
    });
  });

  it('handles empty and very long bodies without crashing', async () => {
    const { judge } = makeJudge(providerReturning(textResponse('{"leak": false, "reason": ""}')));
    expect(await judge.review({ ...MIXED_INPUT, content: '' })).toEqual([]);
    expect(await judge.review({ ...MIXED_INPUT, content: 'x'.repeat(200_000) })).toEqual([]);
  });

  it('publishes one llm.call telemetry event on a successful verdict', async () => {
    const { judge, bus } = makeJudge(providerReturning(textResponse('{"leak": false, "reason": ""}')));
    await judge.review(MIXED_INPUT);
    const calls = (bus as unknown as { published: Array<{ type: string }> }).published.filter((e) => e.type === 'llm.call');
    expect(calls).toHaveLength(1);
  });

  it('does NOT publish telemetry when unreachable (no model response)', async () => {
    const errorResponse: LLMResponse = { type: 'error', error: { message: 'boom' } as never };
    const { judge, bus } = makeJudge(providerReturning(errorResponse), { failMode: 'open' });
    await judge.review(MIXED_INPUT);
    const calls = (bus as unknown as { published: Array<{ type: string }> }).published.filter((e) => e.type === 'llm.call');
    expect(calls).toHaveLength(0);
  });
});
