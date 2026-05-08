// mcp-loader.test.ts — tests for fixed_inputs schema stripping and call-time injection.
//
// These test the pure helper functions extracted from loadMcpServers. The full
// integration path (YAML -> connect -> register) is covered by startup smoke tests;
// these unit tests verify the mechanical correctness of schema manipulation and
// argument merging.

import { describe, it, expect } from 'vitest';
import { stripFixedInputsFromSchema, mergeFixedInputs } from './mcp-loader.js';
import { resolveEnvValue } from '../config.js';

// ---------------------------------------------------------------------------
// stripFixedInputsFromSchema
// ---------------------------------------------------------------------------

describe('stripFixedInputsFromSchema', () => {
  it('removes fixed keys from properties and required', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        user_google_email: { type: 'string', description: 'The user email' },
        query: { type: 'string', description: 'Search query' },
      },
      required: ['user_google_email', 'query'],
    };

    const result = stripFixedInputsFromSchema(schema, ['user_google_email']);

    expect(result.properties).toEqual({
      query: { type: 'string', description: 'Search query' },
    });
    expect(result.required).toEqual(['query']);
  });

  it('does not mutate the original schema', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        user_google_email: { type: 'string' },
        query: { type: 'string' },
      },
      required: ['user_google_email', 'query'],
    };

    stripFixedInputsFromSchema(schema, ['user_google_email']);

    expect(schema.properties).toHaveProperty('user_google_email');
    expect(schema.required).toContain('user_google_email');
  });

  it('returns schema unchanged when fixedKeys is empty', () => {
    const schema = {
      type: 'object' as const,
      properties: { query: { type: 'string' } },
      required: ['query'],
    };

    const result = stripFixedInputsFromSchema(schema, []);

    expect(result).toBe(schema);
  });

  it('handles schema with no required array', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        user_google_email: { type: 'string' },
        query: { type: 'string' },
      },
    };

    const result = stripFixedInputsFromSchema(schema, ['user_google_email']);

    expect(result.properties).toEqual({ query: { type: 'string' } });
    expect(result.required).toBeUndefined();
  });

  it('handles stripping a key not present in schema (no-op)', () => {
    const schema = {
      type: 'object' as const,
      properties: { query: { type: 'string' } },
      required: ['query'],
    };

    const result = stripFixedInputsFromSchema(schema, ['nonexistent_key']);

    expect(result.properties).toEqual({ query: { type: 'string' } });
    expect(result.required).toEqual(['query']);
  });
});

// ---------------------------------------------------------------------------
// mergeFixedInputs
// ---------------------------------------------------------------------------

describe('mergeFixedInputs', () => {
  it('merges fixed values into agent input', () => {
    const agentInput = { query: 'quarterly report' };
    const fixedInputs = { user_google_email: 'curia@example.com' };

    const result = mergeFixedInputs(agentInput, fixedInputs);

    expect(result).toEqual({
      query: 'quarterly report',
      user_google_email: 'curia@example.com',
    });
  });

  it('fixed values override agent-supplied values', () => {
    const agentInput = {
      query: 'quarterly report',
      user_google_email: 'attacker@evil.com',
    };
    const fixedInputs = { user_google_email: 'curia@example.com' };

    const result = mergeFixedInputs(agentInput, fixedInputs);

    expect(result.user_google_email).toBe('curia@example.com');
  });

  it('returns original reference when fixedInputs is empty', () => {
    const agentInput = { query: 'test' };

    const result = mergeFixedInputs(agentInput, {});

    expect(result).toBe(agentInput);
  });
});

// ---------------------------------------------------------------------------
// resolveEnvValue integration (imported from config.ts)
// ---------------------------------------------------------------------------

describe('resolveEnvValue (fixed_inputs context)', () => {
  it('resolves env:VAR_NAME from process.env', () => {
    const original = process.env.TEST_FIXED_INPUT_EMAIL;
    try {
      process.env.TEST_FIXED_INPUT_EMAIL = 'curia@example.com';
      const result = resolveEnvValue('env:TEST_FIXED_INPUT_EMAIL', 'test context');
      expect(result).toBe('curia@example.com');
    } finally {
      if (original === undefined) {
        delete process.env.TEST_FIXED_INPUT_EMAIL;
      } else {
        process.env.TEST_FIXED_INPUT_EMAIL = original;
      }
    }
  });

  it('throws with a clear message when env var is not set', () => {
    delete process.env.DEFINITELY_NOT_SET_VAR;
    expect(() =>
      resolveEnvValue('env:DEFINITELY_NOT_SET_VAR', "MCP server 'google-workspace' fixed_inputs.user_google_email"),
    ).toThrow(/env var "DEFINITELY_NOT_SET_VAR" is not set/);
  });

  it('passes through literal strings unchanged', () => {
    const result = resolveEnvValue('literal@example.com', 'test context');
    expect(result).toBe('literal@example.com');
  });
});
