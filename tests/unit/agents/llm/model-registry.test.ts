import { describe, it, expect, vi } from 'vitest';
import { ModelRegistry } from '../../../../src/agents/llm/model-registry.js';
import { createSilentLogger, type Logger } from '../../../../src/logger.js';

describe('ModelRegistry', () => {
  const registry = new ModelRegistry(createSilentLogger());

  describe('getModel', () => {
    it('returns metadata for an exact model name', () => {
      const meta = registry.getModel('claude-sonnet-4-6');
      expect(meta).toBeDefined();
      expect(meta!.provider).toBe('anthropic');
      expect(meta!.contextWindow).toBe(200_000);
      expect(meta!.pricing.inputPerMToken).toBe(3.0);
    });

    it('matches versioned model names by prefix', () => {
      const meta = registry.getModel('claude-haiku-4-5-20251001');
      expect(meta).toBeDefined();
      expect(meta!.provider).toBe('anthropic');
      expect(meta!.pricing.inputPerMToken).toBe(0.80);
    });

    it('returns undefined for unknown models', () => {
      expect(registry.getModel('unknown-model')).toBeUndefined();
    });

    it('prefers longer prefix matches', () => {
      // 'claude-sonnet-4-6' should not match 'claude-opus-4-6'
      const meta = registry.getModel('claude-sonnet-4-6-preview');
      expect(meta).toBeDefined();
      expect(meta!.pricing.inputPerMToken).toBe(3.0); // sonnet pricing, not opus
    });
  });

  describe('getContextWindow', () => {
    it('returns context window for a known model', () => {
      expect(registry.getContextWindow('claude-opus-4-6')).toBe(200_000);
    });

    it('returns context window for a versioned model name', () => {
      expect(registry.getContextWindow('claude-haiku-4-5-20251001')).toBe(200_000);
    });

    it('returns 0 for unknown models', () => {
      expect(registry.getContextWindow('unknown-model')).toBeUndefined();
    });
  });

  describe('getPricing', () => {
    it('returns pricing for a known model', () => {
      const pricing = registry.getPricing('claude-haiku-4-5');
      expect(pricing).toBeDefined();
      expect(pricing!.inputPerMToken).toBe(0.80);
      expect(pricing!.outputPerMToken).toBe(4.00);
      expect(pricing!.cacheCreationPerMToken).toBe(1.00);
      expect(pricing!.cacheReadPerMToken).toBe(0.08);
    });

    it('returns undefined for unknown models', () => {
      expect(registry.getPricing('unknown-model')).toBeUndefined();
    });
  });

  describe('getProvider', () => {
    it('returns provider for a known model', () => {
      expect(registry.getProvider('claude-sonnet-4-6')).toBe('anthropic');
    });

    it('returns undefined for unknown models', () => {
      expect(registry.getProvider('unknown-model')).toBeUndefined();
    });
  });

  describe('isKnownModel', () => {
    it('returns true for exact match', () => {
      expect(registry.isKnownModel('claude-sonnet-4-6')).toBe(true);
    });

    it('returns true for prefix match', () => {
      expect(registry.isKnownModel('claude-haiku-4-5-20251001')).toBe(true);
    });

    it('returns false for unknown models', () => {
      expect(registry.isKnownModel('unknown-model')).toBe(false);
    });
  });

  describe('getAllModels', () => {
    it('returns all registered models', () => {
      const all = registry.getAllModels();
      expect(Object.keys(all)).toContain('claude-sonnet-4-6');
      expect(Object.keys(all)).toContain('claude-haiku-4-5');
      expect(Object.keys(all)).toContain('claude-opus-4-6');
    });
  });

  describe('OpenRouter models', () => {
    it('resolves google/gemini-3.1-flash-lite with provider openrouter', () => {
      const meta = registry.getModel('google/gemini-3.1-flash-lite');
      expect(meta).toBeDefined();
      expect(meta!.provider).toBe('openrouter');
      expect(meta!.contextWindow).toBe(1_000_000);
      expect(meta!.capabilities).toContain('vision');
      expect(meta!.capabilities).toContain('coding');
    });

    it('returns correct pricing for google/gemini-3.1-flash-lite', () => {
      const pricing = registry.getPricing('google/gemini-3.1-flash-lite');
      expect(pricing).toBeDefined();
      expect(pricing!.inputPerMToken).toBe(0.25);
      expect(pricing!.outputPerMToken).toBe(1.50);
      expect(pricing!.cacheCreationPerMToken).toBeUndefined();
      expect(pricing!.cacheReadPerMToken).toBe(0.025);
    });

    it('resolves google/gemini-2.0-flash-001 with provider openrouter', () => {
      const meta = registry.getModel('google/gemini-2.0-flash-001');
      expect(meta).toBeDefined();
      expect(meta!.provider).toBe('openrouter');
      expect(meta!.contextWindow).toBe(1_000_000);
      expect(meta!.capabilities).toContain('vision');
      expect(meta!.capabilities).toContain('coding');
    });

    it('resolves deepseek/deepseek-chat-v3-0324 with provider openrouter', () => {
      const meta = registry.getModel('deepseek/deepseek-chat-v3-0324');
      expect(meta).toBeDefined();
      expect(meta!.provider).toBe('openrouter');
      expect(meta!.contextWindow).toBe(128_000);
      expect(meta!.capabilities).toContain('coding');
    });

    it('resolves deepseek/deepseek-v4-pro with provider openrouter', () => {
      const meta = registry.getModel('deepseek/deepseek-v4-pro');
      expect(meta).toBeDefined();
      expect(meta!.provider).toBe('openrouter');
      expect(meta!.contextWindow).toBe(1_048_576);
      expect(meta!.capabilities).toContain('coding');
      expect(meta!.capabilities).toContain('reasoning');
    });

    // The promotional $0.435/$0.87 expired mid-August 2026 and sat in the
    // registry for about a month afterwards (#1804).
    it('returns correct pricing for deepseek/deepseek-v4-pro', () => {
      const pricing = registry.getPricing('deepseek/deepseek-v4-pro');
      expect(pricing).toBeDefined();
      expect(pricing!.inputPerMToken).toBe(1.60);
      expect(pricing!.outputPerMToken).toBe(3.20);
      expect(pricing!.cacheCreationPerMToken).toBeUndefined();
      expect(pricing!.cacheReadPerMToken).toBe(0.135);
    });

    it('resolves openai/gpt-4o with provider openrouter', () => {
      const meta = registry.getModel('openai/gpt-4o');
      expect(meta).toBeDefined();
      expect(meta!.provider).toBe('openrouter');
      expect(meta!.contextWindow).toBe(128_000);
      expect(meta!.capabilities).toContain('vision');
      expect(meta!.capabilities).toContain('reasoning');
    });

    it('returns correct pricing for deepseek/deepseek-chat-v3-0324', () => {
      const pricing = registry.getPricing('deepseek/deepseek-chat-v3-0324');
      expect(pricing).toBeDefined();
      expect(pricing!.inputPerMToken).toBe(0.27);
      expect(pricing!.outputPerMToken).toBe(1.10);
      // OpenRouter models don't support Anthropic-style prompt caching
      expect(pricing!.cacheCreationPerMToken).toBeUndefined();
      expect(pricing!.cacheReadPerMToken).toBeUndefined();
    });
  });

  describe('all three Anthropic models are registered', () => {
    it.each([
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ])('%s is registered with provider, pricing, contextWindow, and capabilities', (model) => {
      const meta = registry.getModel(model);
      expect(meta).toBeDefined();
      expect(meta!.provider).toBe('anthropic');
      expect(meta!.contextWindow).toBeGreaterThan(0);
      expect(meta!.pricing.inputPerMToken).toBeGreaterThan(0);
      expect(meta!.pricing.outputPerMToken).toBeGreaterThan(0);
      expect(meta!.capabilities).toContain('vision');
    });
  });

  describe('Embedding models', () => {
    it('text-embedding-3-small is registered with provider openai', () => {
      const meta = registry.getModel('text-embedding-3-small');
      expect(meta).toBeDefined();
      expect(meta!.provider).toBe('openai');
      expect(meta!.contextWindow).toBe(8191);
      expect(meta!.capabilities).toContain('embedding');
    });

    it('text-embedding-3-small has correct pricing ($0.02/MTok input, $0 output)', () => {
      const pricing = registry.getPricing('text-embedding-3-small');
      expect(pricing).toBeDefined();
      expect(pricing!.inputPerMToken).toBe(0.02);
      expect(pricing!.outputPerMToken).toBe(0);
      expect(pricing!.cacheCreationPerMToken).toBeUndefined();
      expect(pricing!.cacheReadPerMToken).toBeUndefined();
    });

    it('text-embedding-3-small does not declare streaming or tools', () => {
      const meta = registry.getModel('text-embedding-3-small');
      expect(meta!.capabilities).not.toContain('streaming');
      expect(meta!.capabilities).not.toContain('tools');
    });
  });

  describe('streaming and tools capabilities (#1553)', () => {
    it.each([
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'google/gemini-3.1-flash-lite',
      'deepseek/deepseek-chat-v3-0324',
      'deepseek/deepseek-v4-pro',
      'deepseek/deepseek-v4-pro-0813',
      'deepseek/deepseek-v4.1-flash',
      'z-ai/glm-5.3-flash',
      'qwen/qwen3.8-flash',
      'openai/gpt-4o',
    ])('%s declares streaming and tools', (model) => {
      const meta = registry.getModel(model);
      expect(meta).toBeDefined();
      expect(meta!.capabilities).toContain('streaming');
      expect(meta!.capabilities).toContain('tools');
    });
  });

  // curia-deploy#226 moves the `standard` tier off deepseek/deepseek-v4-pro.
  // ModelRouter throws on a tier model the registry doesn't know, so every
  // candidate has to be registered before that config can boot (#1804).
  describe('standard-tier replacement candidates (#1804)', () => {
    it('registers deepseek/deepseek-v4.1-flash with its published metadata', () => {
      const meta = registry.getModel('deepseek/deepseek-v4.1-flash');
      expect(meta).toBeDefined();
      expect(meta!.provider).toBe('openrouter');
      expect(meta!.contextWindow).toBe(1_048_576);
      expect(meta!.pricing.inputPerMToken).toBe(0.15);
      expect(meta!.pricing.outputPerMToken).toBe(0.60);
      expect(meta!.pricing.cacheReadPerMToken).toBe(0.003);
      expect(meta!.capabilities).toContain('tools');
    });

    it.each([
      ['deepseek/deepseek-v4-pro-0813', 0.66, 1.98, 0.022],
      ['z-ai/glm-5.3-flash', 0.09, 0.30, 0.018],
      ['qwen/qwen3.8-flash', 0.15, 0.47, 0.016],
    ])('registers %s with its own pricing', (model, input, output, cacheRead) => {
      const meta = registry.getModel(model);
      expect(meta).toBeDefined();
      expect(meta!.provider).toBe('openrouter');
      expect(meta!.pricing.inputPerMToken).toBe(input);
      expect(meta!.pricing.outputPerMToken).toBe(output);
      expect(meta!.pricing.cacheReadPerMToken).toBe(cacheRead);
    });
  });

  describe('exact match wins over prefix match (#1804)', () => {
    // 'deepseek/deepseek-v4-pro-0813'.startsWith('deepseek/deepseek-v4-pro') is
    // true, so before this fix the snapshot silently inherited the V4 Pro entry's
    // pricing, context window and output cap — it booted, and every cost it
    // reported was wrong.
    it('does not resolve deepseek/deepseek-v4-pro-0813 to the deepseek/deepseek-v4-pro entry', () => {
      const snapshot = registry.getModel('deepseek/deepseek-v4-pro-0813');
      const base = registry.getModel('deepseek/deepseek-v4-pro');
      expect(base).toBeDefined();
      expect(snapshot).not.toBe(base);
      expect(snapshot!.pricing.inputPerMToken).not.toBe(base!.pricing.inputPerMToken);
    });

    it('still prefix-matches an unregistered dated snapshot', () => {
      const meta = registry.getModel('claude-haiku-4-5-20251001');
      expect(meta).toBe(registry.getModel('claude-haiku-4-5'));
    });

    it('does not resolve inherited Object properties as models', () => {
      expect(registry.getModel('constructor')).toBeUndefined();
      expect(registry.getModel('toString')).toBeUndefined();
    });
  });

  describe('prefix-match warning (#1804)', () => {
    const makeLogger = () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      silent: vi.fn(),
      child: vi.fn().mockReturnThis(),
      level: 'info',
    });

    it('warns with both the requested id and the matched entry key', () => {
      const logger = makeLogger();
      const reg = new ModelRegistry(logger as unknown as Logger);

      expect(reg.getModel('claude-haiku-4-5-20251001')).toBeDefined();

      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [context, message] = logger.warn.mock.calls[0]!;
      expect(context).toMatchObject({
        modelId: 'claude-haiku-4-5-20251001',
        matchedEntry: 'claude-haiku-4-5',
      });
      expect(message).toContain('claude-haiku-4-5-20251001');
      expect(message).toContain('claude-haiku-4-5');
    });

    it('does not warn on an exact match', () => {
      const logger = makeLogger();
      const reg = new ModelRegistry(logger as unknown as Logger);

      reg.getModel('claude-haiku-4-5');
      reg.getModel('deepseek/deepseek-v4-pro-0813');

      expect(logger.warn).not.toHaveBeenCalled();
    });

    // getPricing/getProvider both call getModel, so an un-deduped warning would
    // fire several times per LLM call for a model id that is wrong only once.
    it('warns once per distinct model id', () => {
      const logger = makeLogger();
      const reg = new ModelRegistry(logger as unknown as Logger);

      reg.getModel('claude-haiku-4-5-20251001');
      reg.getPricing('claude-haiku-4-5-20251001');
      reg.getProvider('claude-haiku-4-5-20251001');
      reg.getModel('claude-sonnet-4-6-preview');

      expect(logger.warn).toHaveBeenCalledTimes(2);
    });
  });

  // A missing cache-read price is not free — pricing.ts treats undefined as 0,
  // so an unrecorded rate silently drops that whole line off the cost estimate.
  // Either record the price or say why there isn't one (#1804).
  describe('cache-read pricing completeness (#1804)', () => {
    const openRouterEntries = Object.entries(registry.getAllModels())
      .filter(([, meta]) => meta.provider === 'openrouter');

    it('covers every openrouter entry', () => {
      expect(openRouterEntries.length).toBeGreaterThan(0);
    });

    it.each(openRouterEntries.map(([key]) => key))(
      '%s has a cache-read price or a documented reason it has none',
      (key) => {
        const meta = registry.getAllModels()[key]!;
        const hasPrice = typeof meta.pricing.cacheReadPerMToken === 'number';
        const hasReason = typeof meta.cacheReadPricingUnavailable === 'string'
          && meta.cacheReadPricingUnavailable.trim().length > 0;

        expect(hasPrice || hasReason).toBe(true);
        // An opt-out is a claim that no price exists — it must not sit next to one.
        expect(hasPrice && hasReason).toBe(false);
      },
    );
  });
});
