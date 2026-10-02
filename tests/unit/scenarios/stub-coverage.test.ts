import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { coverageViolations, mergeCoverage, readCoverage } from '../../scenarios/stub-coverage.js';

describe('readCoverage', () => {
  it('returns an empty record when the file is absent', () => {
    expect(readCoverage('/nonexistent/stub-coverage.json')).toEqual({ cases: {} });
  });

  it('throws on corrupt JSON rather than disabling the gate', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cov-'));
    const file = path.join(dir, 'c.json');
    writeFileSync(file, '{oops');
    expect(() => readCoverage(file)).toThrow(/not valid JSON/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('mergeCoverage', () => {
  it('records the worst run and keeps an allowance', () => {
    const merged = mergeCoverage(
      { cases: { a: { unstubbed: 9, allowUnstubbed: { count: 1, reason: 'memory-store is noise' } }, b: { unstubbed: null, reason: 'new' } } },
      [{ name: 'a', model: 'm', runs: [{ unstubbedCalls: 0 }, { unstubbedCalls: 1 }] }],
    );
    expect(merged.cases['a']).toMatchObject({ unstubbed: 1, runs: 2, model: 'm', allowUnstubbed: { count: 1 } });
    // Untouched cases are kept as they were.
    expect(merged.cases['b']).toEqual({ unstubbed: null, reason: 'new' });
  });

  it('ignores errored runs, and keeps the prior entry when none completed', () => {
    const merged = mergeCoverage(
      { cases: { a: { unstubbed: 3 }, b: { unstubbed: null, reason: 'new' } } },
      [
        { name: 'a', model: 'm', runs: [{ unstubbedCalls: 0, error: 'Timeout' }, { unstubbedCalls: 2 }] },
        { name: 'b', model: 'm', runs: [{ unstubbedCalls: 0, error: 'seed failed' }] },
      ],
    );
    expect(merged.cases['a']).toMatchObject({ unstubbed: 2, runs: 1 });
    expect(merged.cases['b']).toEqual({ unstubbed: null, reason: 'new' });
  });

  it('replaces rather than folds, so a fixed stub table clears', () => {
    const merged = mergeCoverage({ cases: { a: { unstubbed: 4 } } }, [{ name: 'a', model: 'm', runs: [{ unstubbedCalls: 0 }] }]);
    expect(merged.cases['a']!.unstubbed).toBe(0);
  });
});

describe('coverageViolations', () => {
  it('passes measured-clean and documented-unmeasured entries (non-strict)', () => {
    expect(coverageViolations(['a', 'b'], { cases: { a: { unstubbed: 0 }, b: { unstubbed: null, reason: 'new case' } } }, { strict: false })).toEqual([]);
  });

  it('fails unmeasured entries under strict', () => {
    expect(coverageViolations(['b'], { cases: { b: { unstubbed: null, reason: 'new case' } } }, { strict: true })).toHaveLength(1);
  });

  it.each([
    ['a missing entry', {}, /no entry/],
    ['refused calls over the allowance', { a: { unstubbed: 2, allowUnstubbed: { count: 1, reason: 'x' } } }, /2 refused/],
    ['an allowance without a reason', { a: { unstubbed: 0, allowUnstubbed: { count: 1, reason: ' ' } } }, /non-empty reason/],
    ['null without a reason', { a: { unstubbed: null } }, /needs a reason/],
    ['a non-numeric count', { a: { unstubbed: 'abc' } }, /non-negative integer/],
    ['a fractional count', { a: { unstubbed: 0.5 } }, /non-negative integer/],
  ])('fails %s', (_label, cases, error) => {
    const lines = coverageViolations(['a'], { cases: cases as never }, { strict: false });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(error);
  });
});
