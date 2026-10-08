// Comparing a candidate judge with the one that judged a saved run (#1980).
import { describe, expect, it } from 'vitest';
import { formatAgreement, meetsBar, summarize, type CaseComparison, type Rating } from '../../shared/rejudge.js';

function comparison(name: string, passedBefore: boolean, passedAfter: boolean, ratings: Array<[Rating, Rating]> = []): CaseComparison {
  return {
    name,
    passedBefore,
    passedAfter,
    ratings: ratings.map(([before, after], i) => ({
      behaviorId: `b${i}`,
      before: { rating: before, justification: `old ${i}` },
      after: { rating: after, justification: `new ${i}` },
    })),
  };
}

describe('summarize', () => {
  it('counts verdict and rating agreement, and sorts out what changed', () => {
    const agreement = summarize([
      comparison('same', true, true, [['PASS', 'PASS']]),
      comparison('flipped', true, false, [['PASS', 'MISS']]),
      comparison('drifted', true, true, [['PASS', 'PARTIAL'], ['PASS', 'PASS']]),
    ]);
    expect(agreement).toMatchObject({ cases: 3, verdictsAgree: 2, ratings: 4, ratingsAgree: 2 });
    expect(agreement.verdictChanges.map(c => c.name)).toEqual(['flipped']);
    expect(agreement.ratingChanges.map(c => c.name)).toEqual(['drifted']);
  });
});

describe('meetsBar', () => {
  it('needs 95% of verdicts', () => {
    const cases = (agree: number, total: number) =>
      summarize(Array.from({ length: total }, (_, i) => comparison(`c${i}`, true, i < agree)));
    expect(meetsBar(cases(19, 20))).toBe(true);
    expect(meetsBar(cases(18, 20))).toBe(false);
    expect(meetsBar(summarize([]))).toBe(false);
  });
});

describe('formatAgreement', () => {
  it('lists each verdict change with both judges\' reasons', () => {
    const text = formatAgreement(summarize([comparison('flipped', true, false, [['PASS', 'MISS']])]), 'cheap/judge', 'baseline').join('\n');
    expect(text).toContain('Case verdicts:    0/1 agree');
    expect(text).toContain('flipped: baseline PASS → cheap/judge FAIL');
    expect(text).toContain('baseline: old 0');
    expect(text).toContain('cheap/judge: new 0');
  });
});
