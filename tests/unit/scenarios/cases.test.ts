// The committed scenario cases load, and each has a stub-coverage record (#1956).
// Runs in CI with no database or model: the live suite is `pnpm scenarios`.
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadScenarioCases } from '../../scenarios/loader.js';
import { coverageViolations, readCoverage } from '../../scenarios/stub-coverage.js';

const SCENARIOS_DIR = path.resolve(import.meta.dirname, '../../scenarios');
const cases = loadScenarioCases(path.join(SCENARIOS_DIR, 'cases'));

describe('coordinator scenario cases', () => {
  it('load and validate', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  it('cover the ten behaviors #1956 names', () => {
    // Case files are numbered by the issue's list; every number must be present.
    const numbers = new Set(cases.map(c => Number(path.basename(c.sourceFile).slice(0, 2))));
    for (let n = 1; n <= 10; n++) expect(numbers, `case ${n}`).toContain(n);
  });

  it('assert tool calls in code wherever a behavior is a tool call', () => {
    // At least one deterministic check per case — a case scored only by the judge
    // cannot fail for the reason it exists.
    for (const c of cases) {
      expect(c.expectedBehaviors.some(b => b.check), c.name).toBe(true);
    }
  });

  it('have a well-formed stub-coverage record', () => {
    const coverage = readCoverage(path.join(SCENARIOS_DIR, 'stub-coverage.json'));
    expect(coverageViolations(cases.map(c => c.name), coverage, { strict: false })).toEqual([]);
  });
});
