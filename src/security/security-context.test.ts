import { describe, it, expect } from 'vitest';
import { compileSecurityContextBlock, type SecurityThresholds } from './security-context.js';

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
    expect(block).toContain('| 0.3 |');
    expect(block).toContain('| 0.6 |');
    // Default 0.2 / 0.5 must NOT appear (proves interpolation used the arg, not hardcoded)
    expect(block).not.toContain('| 0.2 |');
    expect(block).not.toContain('| 0.5 |');
  });

  it('includes the CEO/CLI trust exemption', () => {
    const block = compileSecurityContextBlock(DEFAULT_THRESHOLDS);
    expect(block).toContain('role: "ceo"');
    expect(block).toContain('channel: "cli"');
  });

  it('default thresholds produce the correct table values', () => {
    const block = compileSecurityContextBlock(DEFAULT_THRESHOLDS);
    expect(block).toContain('| 0.2 |');
    expect(block).toContain('| 0.5 |');
    // 0.8 appears twice — data_export and financial
    const matches = [...block.matchAll(/\| 0\.8 \|/g)];
    expect(matches.length).toBe(2);
  });

  it('returns a non-empty string of meaningful length', () => {
    const block = compileSecurityContextBlock(DEFAULT_THRESHOLDS);
    expect(block.trim().length).toBeGreaterThan(200);
  });
});
