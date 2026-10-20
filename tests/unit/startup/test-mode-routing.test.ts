// test-mode-routing.test.ts — how --model and --reasoning-effort shape a test-mode
// stack's model_routing (ADR-048).

import { describe, it, expect } from 'vitest';
import { routingFor } from '../../../src/startup/test-mode-stack.js';
import { ModelRegistry } from '../../../src/agents/llm/model-registry.js';
import { ModelRouter } from '../../../src/agents/llm/model-router.js';
import { createSilentLogger } from '../../../src/logger.js';
import type { YamlConfig } from '../../../src/config.js';

const logger = createSilentLogger();
const registry = new ModelRegistry(logger);
const yaml = {
  model_routing: {
    tiers: {
      fast: { model: 'claude-haiku-5-5' },
      standard: { model: 'deepseek/deepseek-v4.1-flash', reasoning: { effort: 'high' } },
      powerful: { model: 'openai/gpt-4o' },
    },
    default_tier: 'standard',
  },
} as unknown as YamlConfig;

describe('routingFor', () => {
  it('returns the configured routing when nothing is overridden', () => {
    expect(routingFor(yaml, undefined, undefined, registry)).toBe(yaml.model_routing);
  });

  it('varies only the tiers named, keeping their models', () => {
    const routing = routingFor(yaml, undefined, { fast: { effort: 'none' } }, registry);
    expect(routing.tiers.fast).toEqual({ model: 'claude-haiku-5-5', reasoning: { effort: 'none' } });
    expect(routing.tiers.standard).toEqual({ model: 'deepseek/deepseek-v4.1-flash', reasoning: { effort: 'high' } });
    expect(() => new ModelRouter(routing, registry, logger)).not.toThrow();
  });

  it('drops configured reasoning when --model replaces the tier models', () => {
    const routing = routingFor(yaml, 'deepseek/deepseek-v4.1-flash', undefined, registry);
    expect(routing.tiers.standard).toEqual({ model: 'deepseek/deepseek-v4.1-flash' });
  });

  it('sets every tier with --model and a bare effort', () => {
    const effort = { effort: 'low' as const };
    const routing = routingFor(yaml, 'deepseek/deepseek-v4.1-flash', { fast: effort, standard: effort, powerful: effort }, registry);
    expect(Object.values(routing.tiers)).toEqual([
      { model: 'deepseek/deepseek-v4.1-flash', reasoning: effort },
      { model: 'deepseek/deepseek-v4.1-flash', reasoning: effort },
      { model: 'deepseek/deepseek-v4.1-flash', reasoning: effort },
    ]);
  });

  it('leaves an effort the model cannot take to ModelRouter, which fails the boot', () => {
    const routing = routingFor(yaml, 'deepseek/deepseek-v4.1-flash', { standard: { effort: 'none' } }, registry);
    expect(() => new ModelRouter(routing, registry, logger)).toThrow(/"none" is not supported/);
  });
});
