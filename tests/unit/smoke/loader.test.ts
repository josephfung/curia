import { describe, it, expect } from 'vitest';
import { loadTestCases, loadTestCase } from '../../smoke/loader.js';

describe('Smoke test loader', () => {
  it('loads a single YAML test case', () => {
    const tc = loadTestCase('tests/smoke/cases/forwarded-receipt.yaml');
    expect(tc.name).toBe('Forwarded Receipt (No Context)');
    expect(tc.turns).toHaveLength(1);
    expect(tc.turns[0]!.role).toBe('user');
    expect(tc.expectedBehaviors.length).toBeGreaterThan(0);
    expect(tc.tags).toContain('inference');
  });

  it('loads all test cases from directory', () => {
    const cases = loadTestCases('tests/smoke/cases');
    expect(cases.length).toBeGreaterThan(0);
    for (const tc of cases) {
      expect(tc.name).toBeDefined();
      expect(tc.turns.length).toBeGreaterThan(0);
      expect(tc.expectedBehaviors.length).toBeGreaterThan(0);
    }
  });

  it('validates required fields', () => {
    expect(() => loadTestCase('tests/smoke/cases/nonexistent.yaml')).toThrow();
  });

  it('filters by tag', () => {
    const all = loadTestCases('tests/smoke/cases');
    const filtered = loadTestCases('tests/smoke/cases', { tags: ['inference'] });
    expect(filtered.length).toBeLessThanOrEqual(all.length);
    for (const tc of filtered) {
      expect(tc.tags).toContain('inference');
    }
  });
});
