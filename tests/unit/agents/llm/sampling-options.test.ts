import { describe, it, expect, vi } from 'vitest';
import { NO_REASONING, parseReasoning, parseTemperature, resolveReasoning, resolveTemperature, sentTemperature } from '../../../../src/agents/llm/sampling-options.js';
import { ModelRegistry } from '../../../../src/agents/llm/model-registry.js';
import { createSilentLogger } from '../../../../src/logger.js';
import type { Logger } from '../../../../src/logger.js';

function mockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

describe('parseTemperature', () => {
  it('returns set for a finite number including 0', () => {
    expect(parseTemperature({ temperature: 0 })).toEqual({ kind: 'set', value: 0 });
    expect(parseTemperature({ temperature: 0.7 })).toEqual({ kind: 'set', value: 0.7 });
  });

  it('returns unset when temperature is missing or explicitly undefined', () => {
    expect(parseTemperature(undefined)).toEqual({ kind: 'unset' });
    expect(parseTemperature({})).toEqual({ kind: 'unset' });
    expect(parseTemperature({ temperature: undefined })).toEqual({ kind: 'unset' });
  });

  it('returns invalid for null and non-finite values', () => {
    expect(parseTemperature({ temperature: null })).toEqual({ kind: 'invalid', value: null });
    expect(parseTemperature({ temperature: 'hot' })).toEqual({ kind: 'invalid', value: 'hot' });
    expect(parseTemperature({ temperature: NaN }).kind).toBe('invalid');
    expect(parseTemperature({ temperature: Infinity }).kind).toBe('invalid');
  });
});

describe('resolveTemperature', () => {
  it('returns a finite number including 0', () => {
    const logger = mockLogger();
    expect(resolveTemperature({ temperature: 0 }, logger)).toBe(0);
    expect(resolveTemperature({ temperature: 0.7 }, logger)).toBe(0.7);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns undefined when temperature is unset', () => {
    const logger = mockLogger();
    expect(resolveTemperature(undefined, logger)).toBeUndefined();
    expect(resolveTemperature({}, logger)).toBeUndefined();
    expect(resolveTemperature({ temperature: undefined }, logger)).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns and returns undefined for non-numeric temperature', () => {
    const logger = mockLogger();
    expect(resolveTemperature({ temperature: 'hot' }, logger)).toBeUndefined();
    expect(resolveTemperature({ temperature: null }, logger)).toBeUndefined();
    expect(resolveTemperature({ temperature: NaN }, logger)).toBeUndefined();
    expect(resolveTemperature({ temperature: Infinity }, logger)).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(4);
  });
});

describe('sentTemperature (#2077)', () => {
  it('returns the caller value for a model that accepts sampling parameters', () => {
    expect(sentTemperature({ temperature: 0 }, false)).toBe(0);
    expect(sentTemperature({ temperature: 0.7 }, false)).toBe(0.7);
  });

  it('returns null when unset or invalid', () => {
    expect(sentTemperature(undefined, false)).toBeNull();
    expect(sentTemperature({ temperature: 'hot' }, false)).toBeNull();
  });

  it('returns null for a model that rejects sampling parameters, whatever the caller passed', () => {
    expect(sentTemperature({ temperature: 0 }, true)).toBeNull();
    expect(sentTemperature({ temperature: 1 }, true)).toBeNull();
    expect(sentTemperature(undefined, true)).toBeNull();
  });
});

describe('reasoning options (ADR-048)', () => {
  it('parses unset, set and invalid', () => {
    expect(parseReasoning(undefined)).toEqual({ kind: 'unset' });
    expect(parseReasoning({ reasoning: undefined })).toEqual({ kind: 'unset' });
    expect(parseReasoning({ reasoning: { effort: 'low' } })).toEqual({ kind: 'set', effort: 'low' });
    expect(parseReasoning({ reasoning: NO_REASONING })).toEqual({ kind: 'set', effort: 'none' });
    expect(parseReasoning({ reasoning: { effort: 'xhigh' } })).toEqual({ kind: 'invalid', value: { effort: 'xhigh' } });
    expect(parseReasoning({ reasoning: 'low' })).toEqual({ kind: 'invalid', value: 'low' });
  });

  it('resolves an effort, and warns and falls back to unset on a malformed one', () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    expect(resolveReasoning({ reasoning: { effort: 'max' } }, logger)).toBe('max');
    expect(resolveReasoning({}, logger)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(resolveReasoning({ reasoning: { effort: 'adaptive' } }, logger)).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('NO_REASONING is frozen', () => {
    expect(Object.isFrozen(NO_REASONING)).toBe(true);
  });
});

describe('ModelRegistry reasoning support', () => {
  const registry = new ModelRegistry(createSilentLogger());

  it('lists the efforts each model honors', () => {
    expect(registry.honorsReasoningEffort('deepseek/deepseek-v4.1-flash', 'low')).toBe(true);
    expect(registry.honorsReasoningEffort('deepseek/deepseek-v4.1-flash', 'none')).toBe(false);
    expect(registry.honorsReasoningEffort('google/gemini-3.1-flash-lite', 'none')).toBe(false);
    expect(registry.honorsReasoningEffort('claude-haiku-5-5', 'none')).toBe(true);
    expect(registry.honorsReasoningEffort('claude-haiku-4-5', 'low')).toBe(false);
    expect(registry.honorsReasoningEffort('openai/gpt-4o', 'low')).toBe(false);
    expect(registry.reasoningSupport('claude-sonnet-4-6')?.control).toBe('anthropic-adaptive');
  });

  it('freezes reasoning entries', () => {
    expect(Object.isFrozen(registry.reasoningSupport('claude-haiku-5-5')?.efforts)).toBe(true);
  });
});
