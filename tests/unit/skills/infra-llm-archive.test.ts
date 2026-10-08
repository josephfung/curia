import { describe, it, expect, vi } from 'vitest';
import { InfraLlmService } from '../../../src/skills/infra-llm.js';
import { ModelRegistry } from '../../../src/agents/llm/model-registry.js';
import { ModelRouter } from '../../../src/agents/llm/model-router.js';
import { createSilentLogger } from '../../../src/logger.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { LLMProvider, LLMResponse } from '../../../src/agents/llm/provider.js';

describe('InfraLlmService archive (#2042)', () => {
  it('archives reasoning through the shared response builder', async () => {
    const logger = createSilentLogger();
    const registry = new ModelRegistry(logger);
    const router = new ModelRouter({
      tiers: {
        fast: { model: 'claude-haiku-4-5' },
        standard: { model: 'claude-sonnet-4-6' },
        powerful: { model: 'claude-opus-4-6' },
      },
      default_tier: 'standard',
    }, registry, logger);
    const response: LLMResponse = {
      type: 'text',
      content: 'yes',
      reasoning: 'The prompt is a yes/no question.',
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        reasoningTokens: 1,
      },
      provenance: {
        requestedModel: 'claude-haiku-4-5',
        actualModel: 'claude-haiku-4-5',
        providerRequestId: 'req',
      },
    };
    const provider: LLMProvider = { id: 'anthropic', chat: vi.fn(async () => response) };
    const published: Array<{ archive?: { response?: unknown } }> = [];
    const bus = {
      publish: vi.fn(async (_layer: string, event: { archive?: { response?: unknown } }) => {
        published.push(event);
      }),
    } as unknown as EventBus;
    const service = new InfraLlmService(provider, router, bus, logger, registry);
    const result = await service.scoped({ toolName: 'extract-facts' }).classify('is it ready?');
    expect(result).toEqual({ ok: true, text: 'yes' });
    expect(published[0]?.archive?.response).toEqual({
      type: 'text',
      content: 'yes',
      reasoning: 'The prompt is a yes/no question.',
      reasoningTokens: 1,
    });
  });
});