// pricing.test.ts — unit tests for estimateCostUsd.
//
// Verifies correct pricing for each supported model, prefix-match for versioned
// model names, and the unknown-model fallback to sonnet pricing.

import { describe, it, expect, vi } from 'vitest';
import { createEstimateCostUsd } from './pricing.js';
import { ModelRegistry } from './model-registry.js';
import { createSilentLogger } from '../../logger.js';
import type { LLMUsage } from './provider.js';

const registry = new ModelRegistry(createSilentLogger());
const estimateCostUsd = createEstimateCostUsd(registry);

// A usage object with known token counts for easy manual cost verification.
const makeUsage = (overrides: Partial<LLMUsage> = {}): LLMUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  ...overrides,
});

describe('estimateCostUsd', () => {
  it('calculates cost correctly for claude-sonnet-4-6', () => {
    // 1000 input @ $3/MTok + 500 output @ $15/MTok + 200 cache-create @ $3.75/MTok + 100 cache-read @ $0.30/MTok
    // = 0.003 + 0.0075 + 0.00075 + 0.00003 = 0.01128
    const usage = makeUsage({ inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 200, cacheReadInputTokens: 100 });
    const cost = estimateCostUsd('claude-sonnet-4-6', usage);
    expect(cost).toBeCloseTo(0.01128, 8);
  });

  it('calculates cost correctly for claude-opus-4-6', () => {
    const usage = makeUsage({ inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 200, cacheReadInputTokens: 100 });
    const cost = estimateCostUsd('claude-opus-4-6', usage);
    expect(cost).toBeCloseTo(0.0564, 8);
  });

  it('calculates cost correctly for claude-haiku-4-5', () => {
    const usage = makeUsage({ inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 200, cacheReadInputTokens: 100 });
    const cost = estimateCostUsd('claude-haiku-4-5', usage);
    expect(cost).toBeCloseTo(0.003008, 8);
  });

  it('matches haiku pricing by prefix for versioned model names', () => {
    const usage = makeUsage({ inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 200, cacheReadInputTokens: 100 });
    const versionedCost = estimateCostUsd('claude-haiku-4-5-20251001', usage);
    const baseCost = estimateCostUsd('claude-haiku-4-5', usage);
    expect(versionedCost).toBe(baseCost);
  });

  it('falls back to sonnet pricing for unrecognised models without crashing', () => {
    const usage = makeUsage({ inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 200, cacheReadInputTokens: 100 });
    const fallbackCost = estimateCostUsd('unknown-model-xyz', usage);
    const sonnetCost = estimateCostUsd('claude-sonnet-4-6', usage);
    expect(fallbackCost).toBe(sonnetCost);
  });

  it('logs a warning for unrecognised models', () => {
    const warnFn = vi.fn();
    const mockLogger = { warn: warnFn } as never;
    const usage = makeUsage({ inputTokens: 100 });
    estimateCostUsd('mystery-model', usage, mockLogger);
    expect(warnFn).toHaveBeenCalledOnce();
    expect(warnFn.mock.calls[0]![0]).toMatchObject({ actualModel: 'mystery-model', fallback: 'claude-sonnet-4-6' });
  });

  it('returns 0 when all token counts are 0', () => {
    const cost = estimateCostUsd('claude-sonnet-4-6', makeUsage());
    expect(cost).toBe(0);
  });
});
