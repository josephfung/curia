import { describe, it, expect, vi } from 'vitest';
import { resolveTemperature } from '../../../../src/agents/llm/sampling-options.js';
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
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns and returns undefined for non-numeric temperature', () => {
    const logger = mockLogger();
    expect(resolveTemperature({ temperature: 'hot' }, logger)).toBeUndefined();
    expect(resolveTemperature({ temperature: NaN }, logger)).toBeUndefined();
    expect(resolveTemperature({ temperature: Infinity }, logger)).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });
});
