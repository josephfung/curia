import { describe, it, expect, vi } from 'vitest';
import { parseTemperature, resolveTemperature } from '../../../../src/agents/llm/sampling-options.js';
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
