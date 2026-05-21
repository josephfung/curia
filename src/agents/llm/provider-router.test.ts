// provider-router.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMProviderRouter } from './provider-router.js';
import type { LLMProvider, LLMResponse } from './provider.js';
import type { ModelRegistry } from './model-registry.js';

// Minimal ModelRegistry stub — only getProvider() is needed by the router.
function makeModelRegistry(mapping: Record<string, string>): ModelRegistry {
  return {
    getProvider: (model: string) => {
      // Prefix match (same logic as the real registry)
      const key = Object.keys(mapping).find(k => model.startsWith(k));
      return key ? mapping[key] : undefined;
    },
  } as unknown as ModelRegistry;
}

function makeProvider(id: string): LLMProvider {
  const okResponse: LLMResponse = {
    type: 'text',
    content: `response from ${id}`,
    usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    provenance: { requestedModel: 'test-model', actualModel: 'test-model', providerRequestId: 'req-1' },
  };
  return {
    id,
    chat: vi.fn().mockResolvedValue(okResponse),
  };
}

const MESSAGES = [{ role: 'user' as const, content: 'hello' }];

describe('LLMProviderRouter', () => {
  let anthropicProvider: LLMProvider;
  let openrouterProvider: LLMProvider;
  let providerRegistry: Map<string, LLMProvider>;

  beforeEach(() => {
    anthropicProvider = makeProvider('anthropic');
    openrouterProvider = makeProvider('openrouter');
    providerRegistry = new Map([
      ['anthropic', anthropicProvider],
      ['openrouter', openrouterProvider],
    ]);
  });

  it('routes an Anthropic model to the anthropic provider', async () => {
    const modelRegistry = makeModelRegistry({ 'claude-sonnet-4-6': 'anthropic' });
    const router = new LLMProviderRouter(modelRegistry, providerRegistry);

    const result = await router.chat({ messages: MESSAGES, model: 'claude-sonnet-4-6-20251020' });

    expect(anthropicProvider.chat).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-4-6-20251020' }),
    );
    expect(openrouterProvider.chat).not.toHaveBeenCalled();
    expect(result.type).toBe('text');
  });

  it('routes an OpenRouter model to the openrouter provider', async () => {
    const modelRegistry = makeModelRegistry({
      'claude-sonnet-4-6': 'anthropic',
      'deepseek/deepseek-chat-v3-0324': 'openrouter',
    });
    const router = new LLMProviderRouter(modelRegistry, providerRegistry);

    await router.chat({ messages: MESSAGES, model: 'deepseek/deepseek-chat-v3-0324' });

    expect(openrouterProvider.chat).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'deepseek/deepseek-chat-v3-0324' }),
    );
    expect(anthropicProvider.chat).not.toHaveBeenCalled();
  });

  it('routes correctly even when a non-Anthropic model is the standard tier', async () => {
    // This is the key scenario from issue #646:
    // if the operator remaps 'standard' to an OpenRouter model,
    // the router should use the OpenRouter provider, not Anthropic.
    const modelRegistry = makeModelRegistry({ 'deepseek/deepseek-chat-v3-0324': 'openrouter' });
    const router = new LLMProviderRouter(modelRegistry, providerRegistry);

    await router.chat({ messages: MESSAGES, model: 'deepseek/deepseek-chat-v3-0324' });

    expect(openrouterProvider.chat).toHaveBeenCalledTimes(1);
    expect(anthropicProvider.chat).not.toHaveBeenCalled();
  });

  it('supports options.model fallback for callers that pass model inside options', async () => {
    const modelRegistry = makeModelRegistry({ 'claude-haiku-4-5': 'anthropic' });
    const router = new LLMProviderRouter(modelRegistry, providerRegistry);

    await router.chat({
      messages: MESSAGES,
      options: { model: 'claude-haiku-4-5', max_tokens: 100 },
    });

    expect(anthropicProvider.chat).toHaveBeenCalledTimes(1);
  });

  it('throws when no model is provided', async () => {
    const modelRegistry = makeModelRegistry({});
    const router = new LLMProviderRouter(modelRegistry, providerRegistry);

    await expect(router.chat({ messages: MESSAGES })).rejects.toThrow(
      'LLMProviderRouter.chat() requires a model',
    );
  });

  it('throws when the model is not in the registry', async () => {
    const modelRegistry = makeModelRegistry({});
    const router = new LLMProviderRouter(modelRegistry, providerRegistry);

    await expect(
      router.chat({ messages: MESSAGES, model: 'unknown-model-xyz' }),
    ).rejects.toThrow("not in the model registry");
  });

  it('throws when the provider is not registered', async () => {
    const modelRegistry = makeModelRegistry({ 'some-model': 'missing-provider' });
    const router = new LLMProviderRouter(modelRegistry, providerRegistry);

    await expect(
      router.chat({ messages: MESSAGES, model: 'some-model' }),
    ).rejects.toThrow("provider 'missing-provider' is not registered");
  });

  it('passes all params through to the resolved provider unchanged', async () => {
    const modelRegistry = makeModelRegistry({ 'claude-sonnet-4-6': 'anthropic' });
    const router = new LLMProviderRouter(modelRegistry, providerRegistry);
    const tools = [{ name: 'my-tool', description: 'a tool', input_schema: { type: 'object' as const, properties: {} } }];
    const options = { max_tokens: 500, temperature: 0 };

    await router.chat({ messages: MESSAGES, model: 'claude-sonnet-4-6', tools, options });

    expect(anthropicProvider.chat).toHaveBeenCalledWith({
      messages: MESSAGES,
      model: 'claude-sonnet-4-6',
      tools,
      options,
    });
  });
});
