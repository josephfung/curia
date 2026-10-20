// reasoning-flag.test.ts — the suites' --reasoning-effort flag (ADR-048).

import { describe, it, expect } from 'vitest';
import { describeReasoningOverride, parseReasoningEffortFlag } from '../../shared/reasoning-flag.js';
import { parseSmokeArgs } from '../../smoke/args.js';

describe('parseReasoningEffortFlag', () => {
  it('sets every tier from a bare effort', () => {
    expect(parseReasoningEffortFlag('low')).toEqual({ fast: { effort: 'low' }, standard: { effort: 'low' }, powerful: { effort: 'low' } });
  });

  it('sets only the tiers named', () => {
    expect(parseReasoningEffortFlag('fast=none, standard=max')).toEqual({ fast: { effort: 'none' }, standard: { effort: 'max' } });
  });

  it.each([
    ['xhigh', /not one of/],
    ['slow=low', /not a tier/],
    ['fast=low,fast=high', /given twice/],
    ['fast=low=high', /write '<tier>=<effort>'/],
    ['fast=', /write '<tier>=<effort>'/],
  ])('rejects %s', (raw, error) => {
    expect(() => parseReasoningEffortFlag(raw)).toThrow(error);
  });
});

describe('describeReasoningOverride', () => {
  it('labels the arm for the run header and results', () => {
    expect(describeReasoningOverride(undefined)).toBe('as configured');
    expect(describeReasoningOverride(parseReasoningEffortFlag('low'))).toBe('fast=low, standard=low, powerful=low');
    expect(describeReasoningOverride(parseReasoningEffortFlag('fast=none'))).toBe('fast=none (other tiers as configured)');
  });
});

describe('smoke --reasoning-effort', () => {
  it('parses into the run arguments', () => {
    expect(parseSmokeArgs(['--reasoning-effort', 'standard=low']).reasoning).toEqual({ standard: { effort: 'low' } });
  });

  it('rejects it twice', () => {
    expect(() => parseSmokeArgs(['--reasoning-effort', 'low', '--reasoning-effort', 'max'])).toThrow(/given twice/);
  });
});
