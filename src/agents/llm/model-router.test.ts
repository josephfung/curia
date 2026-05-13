import { describe, it, expect } from 'vitest';
import { ModelRouter, type ModelRoutingConfig } from './model-router.js';
import { createSilentLogger } from '../../logger.js';

const defaultConfig: ModelRoutingConfig = {
  tiers: {
    fast: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    standard: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    powerful: { provider: 'anthropic', model: 'claude-opus-4-6' },
  },
  default_tier: 'standard',
};

describe('ModelRouter', () => {
  it('resolves fast tier to the configured model', () => {
    const router = new ModelRouter(defaultConfig, createSilentLogger());
    const result = router.resolve('fast');
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5', tier: 'fast' });
  });

  it('resolves standard tier to the configured model', () => {
    const router = new ModelRouter(defaultConfig, createSilentLogger());
    const result = router.resolve('standard');
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6', tier: 'standard' });
  });

  it('resolves powerful tier to the configured model', () => {
    const router = new ModelRouter(defaultConfig, createSilentLogger());
    const result = router.resolve('powerful');
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-opus-4-6', tier: 'powerful' });
  });

  it('throws on unknown tier', () => {
    const router = new ModelRouter(defaultConfig, createSilentLogger());
    expect(() => router.resolve('ultra' as any)).toThrow('Unknown model tier');
  });

  it('passes needs through without validation', () => {
    const router = new ModelRouter(defaultConfig, createSilentLogger());
    const result = router.resolve('standard', ['vision', 'large_context']);
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it('falls back to default_tier when tier is omitted', () => {
    const router = new ModelRouter(defaultConfig, createSilentLogger());
    const result = router.resolve(undefined);
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6', tier: 'standard' });
  });

  it('throws at construction if a tier config is missing', () => {
    const config = {
      tiers: {
        fast: { provider: 'anthropic', model: 'claude-haiku-4-5' },
        standard: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      } as any,
      default_tier: 'standard' as const,
    };
    expect(() => new ModelRouter(config, createSilentLogger())).toThrow('model_routing.tiers.powerful');
  });

  it('throws at construction if a tier has empty model', () => {
    const config: ModelRoutingConfig = {
      tiers: {
        fast: { provider: 'anthropic', model: 'claude-haiku-4-5' },
        standard: { provider: 'anthropic', model: '' },
        powerful: { provider: 'anthropic', model: 'claude-opus-4-6' },
      },
      default_tier: 'standard',
    };
    expect(() => new ModelRouter(config, createSilentLogger())).toThrow('model_routing.tiers.standard');
  });

  it('works with a non-anthropic provider in config', () => {
    const config: ModelRoutingConfig = {
      tiers: {
        fast: { provider: 'openrouter', model: 'meta-llama/llama-3-8b' },
        standard: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        powerful: { provider: 'anthropic', model: 'claude-opus-4-6' },
      },
      default_tier: 'standard',
    };
    const router = new ModelRouter(config, createSilentLogger());
    const result = router.resolve('fast');
    expect(result).toEqual({ provider: 'openrouter', model: 'meta-llama/llama-3-8b', tier: 'fast' });
  });
});
