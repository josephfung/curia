import { describe, it, expect } from 'vitest';
import { ModelRegistry } from './model-registry.js';
import { createSilentLogger } from '../../logger.js';

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
      expect(registry.getContextWindow('unknown-model')).toBe(0);
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
});
