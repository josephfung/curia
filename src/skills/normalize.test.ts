import { describe, it, expect } from 'vitest';
import { normalizeKeysToSnakeCase } from './normalize.js';

describe('normalizeKeysToSnakeCase', () => {
  it('converts camelCase keys to snake_case', () => {
    expect(normalizeKeysToSnakeCase({ signOff: 'hello' }))
      .toEqual({ sign_off: 'hello' });
  });

  it('leaves snake_case keys unchanged', () => {
    expect(normalizeKeysToSnakeCase({ sign_off: 'hello' }))
      .toEqual({ sign_off: 'hello' });
  });

  it('leaves single-word keys unchanged', () => {
    expect(normalizeKeysToSnakeCase({ tone: ['direct'], formality: 50 }))
      .toEqual({ tone: ['direct'], formality: 50 });
  });

  it('handles multiple camelCase keys', () => {
    expect(normalizeKeysToSnakeCase({
      signOff: 'Cheers',
      emailGreeting: 'Hi there',
      writingStyle: 'formal',
    })).toEqual({
      sign_off: 'Cheers',
      email_greeting: 'Hi there',
      writing_style: 'formal',
    });
  });

  it('prefers snake_case value when both conventions are present', () => {
    expect(normalizeKeysToSnakeCase({
      signOff: 'from camelCase',
      sign_off: 'from snake_case',
    })).toEqual({ sign_off: 'from snake_case' });
  });

  it('prefers snake_case regardless of key order', () => {
    expect(normalizeKeysToSnakeCase({
      sign_off: 'from snake_case',
      signOff: 'from camelCase',
    })).toEqual({ sign_off: 'from snake_case' });
  });

  it('returns an empty object for empty input', () => {
    expect(normalizeKeysToSnakeCase({})).toEqual({});
  });

  it('preserves values of all types', () => {
    const result = normalizeKeysToSnakeCase({
      stringVal: 'text',
      numVal: 42,
      boolVal: true,
      arrayVal: [1, 2],
      objVal: { nested: true },
      nullVal: null,
    });
    expect(result).toEqual({
      string_val: 'text',
      num_val: 42,
      bool_val: true,
      array_val: [1, 2],
      obj_val: { nested: true },
      null_val: null,
    });
  });

  it('does not recurse into nested objects', () => {
    const result = normalizeKeysToSnakeCase({
      vocabulary: { preferWords: ['hello'], avoidWords: ['bye'] },
    });
    // Top-level key unchanged (single word), nested keys NOT converted
    expect(result).toEqual({
      vocabulary: { preferWords: ['hello'], avoidWords: ['bye'] },
    });
  });
});
