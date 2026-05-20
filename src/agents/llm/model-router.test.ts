import { describe, it, expect } from 'vitest';
import { ModelRouter, type ModelRoutingConfig } from './model-router.js';
import { ModelRegistry } from './model-registry.js';
import { createSilentLogger } from '../../logger.js';

const logger = createSilentLogger();
const registry = new ModelRegistry(logger);

const defaultConfig: ModelRoutingConfig = {
  tiers: {
    fast: { model: 'claude-haiku-4-5' },
    standard: { model: 'claude-sonnet-4-6' },
    powerful: { model: 'claude-opus-4-6' },
  },
  default_tier: 'standard',
};

describe('ModelRouter', () => {
  it('resolves fast tier to the configured model', () => {
    const router = new ModelRouter(defaultConfig, registry, logger);
    const result = router.resolve('fast');
    expect(result).toEqual({ model: 'claude-haiku-4-5', tier: 'fast' });
  });

  it('resolves standard tier to the configured model', () => {
    const router = new ModelRouter(defaultConfig, registry, logger);
    const result = router.resolve('standard');
    expect(result).toEqual({ model: 'claude-sonnet-4-6', tier: 'standard' });
  });

  it('resolves powerful tier to the configured model', () => {
    const router = new ModelRouter(defaultConfig, registry, logger);
    const result = router.resolve('powerful');
    expect(result).toEqual({ model: 'claude-opus-4-6', tier: 'powerful' });
  });

  it('throws on unknown tier', () => {
    const router = new ModelRouter(defaultConfig, registry, logger);
    expect(() => router.resolve('ultra')).toThrow('Unknown model tier');
  });

  it('passes needs through without validation', () => {
    const router = new ModelRouter(defaultConfig, registry, logger);
    const result = router.resolve('standard', ['vision', 'large_context']);
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it('falls back to default_tier when tier is omitted', () => {
    const router = new ModelRouter(defaultConfig, registry, logger);
    const result = router.resolve(undefined);
    expect(result).toEqual({ model: 'claude-sonnet-4-6', tier: 'standard' });
  });

  it('throws at construction if a tier config is missing', () => {
    const config: ModelRoutingConfig = {
      tiers: {
        fast: { model: 'claude-haiku-4-5' },
        standard: { model: 'claude-sonnet-4-6' },
        // @ts-expect-error — intentionally omitting powerful to test validation
        powerful: undefined,
      },
      default_tier: 'standard',
    };
    expect(() => new ModelRouter(config, registry, logger)).toThrow('model_routing.tiers.powerful');
  });

  it('throws at construction if a tier has empty model', () => {
    const config: ModelRoutingConfig = {
      tiers: {
        fast: { model: 'claude-haiku-4-5' },
        standard: { model: '' },
        powerful: { model: 'claude-opus-4-6' },
      },
      default_tier: 'standard',
    };
    expect(() => new ModelRouter(config, registry, logger)).toThrow('model_routing.tiers.standard');
  });

  it('throws at construction if a tier references an unknown model', () => {
    const config: ModelRoutingConfig = {
      tiers: {
        fast: { model: 'claude-haiku-4-5' },
        standard: { model: 'unknown-model-xyz' },
        powerful: { model: 'claude-opus-4-6' },
      },
      default_tier: 'standard',
    };
    expect(() => new ModelRouter(config, registry, logger)).toThrow('not found in the model registry');
  });
});
