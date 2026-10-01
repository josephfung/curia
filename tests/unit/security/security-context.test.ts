import { describe, it, expect } from 'vitest';
import {
  compileSecurityContextBlock,
  resolveSecurityThresholds,
  type SecurityThresholds,
} from '../../../src/security/security-context.js';

const DEFAULT_THRESHOLDS: SecurityThresholds = {
  information_query: 0.2,
  scheduling: 0.5,
  data_export: 0.8,
  financial: 0.8,
};

describe('compileSecurityContextBlock', () => {
  it('includes all four section headers', () => {
    const block = compileSecurityContextBlock(DEFAULT_THRESHOLDS);
    expect(block).toContain('## Authorization Enforcement');
    expect(block).toContain('## Prompt Injection Defense');
    expect(block).toContain('## Email Sender Verification');
    expect(block).toContain('## Message Trust Score');
  });

  it('interpolates custom threshold values into the action table', () => {
    const custom: SecurityThresholds = {
      information_query: 0.3,
      scheduling: 0.6,
      data_export: 0.9,
      financial: 0.9,
    };
    const block = compileSecurityContextBlock(custom);
    // Custom values must appear
    expect(block).toContain('| 0.30 |');
    expect(block).toContain('| 0.60 |');
    // Default 0.20 / 0.50 must NOT appear (proves interpolation used the arg, not hardcoded)
    expect(block).not.toContain('| 0.20 |');
    expect(block).not.toContain('| 0.50 |');
  });

  it('includes the principal/CLI trust exemption', () => {
    const block = compileSecurityContextBlock(DEFAULT_THRESHOLDS);
    expect(block).toContain('system role "principal"');
    expect(block).toContain('channel "cli"');
    expect(block).not.toContain('CEO');
  });

  it('default thresholds produce the correct table values', () => {
    const block = compileSecurityContextBlock(DEFAULT_THRESHOLDS);
    expect(block).toContain('| 0.20 |');
    expect(block).toContain('| 0.50 |');
    // 0.80 appears twice — data_export and financial
    const matches = [...block.matchAll(/\| 0\.80 \|/g)];
    expect(matches.length).toBe(2);
  });

  it('returns a non-empty string of meaningful length', () => {
    const block = compileSecurityContextBlock(DEFAULT_THRESHOLDS);
    expect(block.trim().length).toBeGreaterThan(200);
  });
});

// Shared by src/index.ts and the test-mode stack (#1966). No defaults: a config
// that production would refuse to boot with must not render a prompt either.
describe('resolveSecurityThresholds', () => {
  it('accepts a complete, in-range config', () => {
    expect(resolveSecurityThresholds(DEFAULT_THRESHOLDS)).toEqual({ ok: true, thresholds: DEFAULT_THRESHOLDS });
  });

  it('rejects an absent block', () => {
    expect(resolveSecurityThresholds(undefined)).toEqual({ ok: false, reason: 'absent' });
  });

  it('names the missing fields instead of defaulting them', () => {
    expect(resolveSecurityThresholds({ information_query: 0.3, scheduling: 0.5 })).toEqual({
      ok: false,
      reason: 'missing_fields',
      fields: ['data_export', 'financial'],
    });
  });

  it('rejects values that are not finite numbers', () => {
    const raw = { ...DEFAULT_THRESHOLDS, scheduling: null, data_export: Number.NaN, financial: '0.7' };
    expect(resolveSecurityThresholds(raw as unknown as Partial<SecurityThresholds>)).toEqual({
      ok: false,
      reason: 'out_of_range',
      fields: ['scheduling', 'data_export', 'financial'],
    });
  });

  it('names the out-of-range fields', () => {
    expect(resolveSecurityThresholds({ ...DEFAULT_THRESHOLDS, scheduling: 1.5, financial: -0.1 })).toEqual({
      ok: false,
      reason: 'out_of_range',
      fields: ['scheduling', 'financial'],
    });
  });
});
