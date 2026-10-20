// llm-call-reasoning.test.ts — every llm.call publisher records the reasoning
// fields ADR-048 §5 adds: reasoningTokens, reasoningEffort and upstreamProvider.
// The runtime's own publisher is covered in tests/unit/agents/runtime.test.ts.

import { describe, it, expect, vi } from 'vitest';
import { llmCallReasoningFields } from '../../../../src/agents/llm/llm-call-reasoning.js';
import { TelemetryLlmProvider } from '../../../../src/agents/llm/telemetry-provider.js';
import { ModelRegistry } from '../../../../src/agents/llm/model-registry.js';
import { ModelRouter } from '../../../../src/agents/llm/model-router.js';
import { InfraLlmService } from '../../../../src/skills/infra-llm.js';
import { OutboundLlmJudge } from '../../../../src/dispatch/outbound-judge.js';
import { EscalationJudge } from '../../../../src/autonomy/escalation-judge.js';
import { createSilentLogger } from '../../../../src/logger.js';
import type { LLMCallProvenance, LLMProvider, LLMResponse, LLMUsage } from '../../../../src/agents/llm/provider.js';
import type { EventBus } from '../../../../src/bus/bus.js';
import type { FilterRecipient } from '../../../../src/dispatch/outbound-filter.js';

const logger = createSilentLogger();
const registry = new ModelRegistry(logger);

const MODEL = 'deepseek/deepseek-v4.1-flash';

function usage(reasoningTokens?: number): LLMUsage {
  return {
    inputTokens: 10,
    outputTokens: 50,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

function provenance(upstreamProvider?: string): LLMCallProvenance {
  return {
    requestedModel: MODEL,
    actualModel: MODEL,
    providerRequestId: 'gen-1',
    ...(upstreamProvider !== undefined ? { upstreamProvider } : {}),
  };
}

/** A provider whose every call returns `content` with the given usage and provenance. */
function stubProvider(content: string, u: LLMUsage, p: LLMCallProvenance): LLMProvider {
  const response: LLMResponse = { type: 'text', content, usage: u, provenance: p };
  return { id: 'openrouter', chat: vi.fn(async () => response) };
}

function recordingBus(): { bus: EventBus; llmCallPayloads: () => Array<Record<string, unknown>> } {
  const publish = vi.fn(async () => undefined);
  return {
    bus: { publish } as unknown as EventBus,
    llmCallPayloads: () =>
      (publish.mock.calls as unknown as Array<[string, { type: string; payload: Record<string, unknown> }]>)
        .map(([, event]) => event)
        .filter((event) => event.type === 'llm.call')
        .map((event) => event.payload),
  };
}

const reported = { reasoningTokens: 42, reasoningEffort: null, upstreamProvider: 'CoreWeave' };
const unreported = { reasoningTokens: null, reasoningEffort: null, upstreamProvider: null };

describe('llmCallReasoningFields', () => {
  it('carries the reported reasoning tokens and upstream endpoint', () => {
    expect(llmCallReasoningFields(usage(42), provenance('CoreWeave'))).toEqual(reported);
  });

  it('records a reported zero as 0, not null', () => {
    expect(llmCallReasoningFields(usage(0), provenance()).reasoningTokens).toBe(0);
  });

  it('records null for fields the provider did not report', () => {
    expect(llmCallReasoningFields(usage(), provenance())).toEqual(unreported);
  });
});

describe('llm.call publishers record the reasoning fields (ADR-048 §5)', () => {
  for (const [label, u, p, expected] of [
    ['reported', usage(42), provenance('CoreWeave'), reported],
    ['not reported', usage(), provenance(), unreported],
  ] as const) {
    describe(`when ${label}`, () => {
      it('TelemetryLlmProvider', async () => {
        const { bus, llmCallPayloads } = recordingBus();
        const provider = new TelemetryLlmProvider(stubProvider('ok', u, p), bus, logger, 'drift-detector', registry);
        await provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: MODEL });
        expect(llmCallPayloads()[0]).toMatchObject(expected);
      });

      it('InfraLlmService', async () => {
        const { bus, llmCallPayloads } = recordingBus();
        const router = new ModelRouter({
          tiers: { fast: { model: MODEL }, standard: { model: MODEL }, powerful: { model: MODEL } },
          default_tier: 'standard',
        }, registry, logger);
        const service = new InfraLlmService(stubProvider('yes', u, p), router, bus, logger, registry);
        await service.scoped({ toolName: 'extract-facts' }).classify('is it ready?');
        expect(llmCallPayloads()[0]).toMatchObject(expected);
      });

      it('outbound judge', async () => {
        const { bus, llmCallPayloads } = recordingBus();
        const judge = new OutboundLlmJudge(
          stubProvider('{"leak": false, "reason": ""}', u, p),
          { enabled: true, model: MODEL, timeoutMs: 5000, failMode: 'split' },
          bus,
          logger,
          registry,
        );
        const external: FilterRecipient = { email: 'armin@external.com', isPrincipal: false };
        await judge.review({
          content: 'Friday works.',
          recipients: [external],
          principalIncluded: false,
          principalIsSoleRecipient: false,
          conversationId: 'c1',
          channelId: 'email',
        });
        expect(llmCallPayloads()[0]).toMatchObject(expected);
      });

      it('escalation judge', async () => {
        const { bus, llmCallPayloads } = recordingBus();
        const judge = new EscalationJudge(
          stubProvider('{"class": "public", "reason": "fine"}', u, p),
          { enabled: true, model: MODEL, timeoutMs: 5000 },
          bus,
          logger,
          registry,
        );
        await judge.classifyDisclosure({ content: 'hello', recipientTier: 'unknown', conversationId: 'c1' });
        expect(llmCallPayloads()[0]).toMatchObject(expected);
      });
    });
  }
});
