// outbound-filter-wiring.test.ts — escalation.judge config parsing (#2159: review_timeout_ms).

import { describe, expect, it, vi } from 'vitest';
import { buildEscalationJudge, buildOutboundContentFilter, EscalationJudgeConfigError } from '../../../src/dispatch/outbound-filter-wiring.js';
import { ModelRegistry } from '../../../src/agents/llm/model-registry.js';
import type { LLMProvider, LLMResponse } from '../../../src/agents/llm/provider.js';
import type { EventBus } from '../../../src/bus/bus.js';
import { createSilentLogger } from '../../../src/logger.js';

const logger = createSilentLogger();

function deps(judgeYaml: Record<string, unknown>) {
  const modelRegistry = new ModelRegistry(logger);
  const providerName = modelRegistry.getProvider('claude-haiku-4-5')!;
  // A provider that never answers, so only the timeout can end a call.
  const provider = { id: providerName, chat: vi.fn(() => new Promise<LLMResponse>(() => {})) } as unknown as LLMProvider;
  return {
    yaml: judgeYaml,
    modelRegistry,
    providerRegistry: new Map([[providerName, provider]]),
    bus: { publish: vi.fn() } as unknown as EventBus,
    logger,
  };
}

const brief = {
  questions: ['grounding'] as const,
  message: 'x',
  recipients: [],
  band: 'spot-check' as const,
  evidence: { toolResults: [] },
  conversationId: 'c',
};

describe('buildEscalationJudge — review_timeout_ms (#2159)', () => {
  it('applies review_timeout_ms to the band brief', async () => {
    const judge = buildEscalationJudge(deps({ review_timeout_ms: 300 }))!;
    const started = Date.now();
    await expect(judge.review(brief)).resolves.toEqual({ ok: false, failure: 'unreachable' });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('rejects a review_timeout_ms past the Node.js timer limit (it would fire at once)', () => {
    expect(() => buildEscalationJudge(deps({ review_timeout_ms: 3_000_000_000 }))).toThrow(/review_timeout_ms must be an integer >= 250 and <= 2147483647/);
  });

  it('rejects a review_timeout_ms below 250', () => {
    expect(() => buildEscalationJudge(deps({ review_timeout_ms: 10 }))).toThrow(EscalationJudgeConfigError);
    expect(() => buildEscalationJudge(deps({ review_timeout_ms: 10 }))).toThrow(/review_timeout_ms must be an integer >= 250/);
  });
});

describe('buildOutboundContentFilter — band gating boot log (#2159)', () => {
  it('logs band review at info, not as an inactive gate', () => {
    const info = vi.fn();
    const warn = vi.fn();
    const log = { ...createSilentLogger(), info, warn } as unknown as ReturnType<typeof createSilentLogger>;
    buildOutboundContentFilter({ systemPromptMarkers: [], ceoEmail: '', escalationJudge: undefined, gating: 'band', logger: log });
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ disclosureGate: 'band-review' }), expect.stringContaining('band gating'));
  });
});
