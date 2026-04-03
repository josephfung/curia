import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTestCases, loadTestCase } from '../../smoke/loader.js';

// Track temp dirs created in this suite for cleanup
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Minimal valid YAML test case content
function minimalYaml(name: string): string {
  return [
    `name: ${name}`,
    'turns:',
    '  - content: hello',
    'expected_behaviors:',
    '  - id: respond',
    '    description: Responds to user',
    '    weight: important',
  ].join('\n');
}

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

  it('throws on duplicate test case names across files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'curia-smoke-test-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'a.yaml'), minimalYaml('Duplicate Name'));
    writeFileSync(join(dir, 'b.yaml'), minimalYaml('Duplicate Name'));

    expect(() => loadTestCases(dir)).toThrow(/Duplicate test case name 'Duplicate Name'/);
  });

  it('throws on case-insensitive duplicate names to match CLI --case filter semantics', () => {
    const dir = mkdtempSync(join(tmpdir(), 'curia-smoke-test-'));
    tempDirs.push(dir);
    // 'Invoice' and 'invoice' are distinct to a case-sensitive Set but both match
    // `--case invoice` in the CLI, so we treat them as duplicates.
    writeFileSync(join(dir, 'a.yaml'), minimalYaml('Invoice'));
    writeFileSync(join(dir, 'b.yaml'), minimalYaml('invoice'));

    expect(() => loadTestCases(dir)).toThrow(/Duplicate test case name/);
  });

  it('does not throw when all test case names are unique', () => {
    const dir = mkdtempSync(join(tmpdir(), 'curia-smoke-test-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'a.yaml'), minimalYaml('Case A'));
    writeFileSync(join(dir, 'b.yaml'), minimalYaml('Case B'));

    expect(() => loadTestCases(dir)).not.toThrow();
  });
});
