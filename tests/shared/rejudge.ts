// tests/shared/rejudge.ts — how far a candidate judge agrees with the one that judged a
// saved run (#1980).
//
// The judge (gpt-4o) is priced well above the model under test. A cheaper judge can be
// tried without re-running any model: re-judge the transcripts a run saved and compare
// verdicts. The bar for switching is the same pass/fail verdict on at least
// REJUDGE_AGREEMENT_BAR of cases, with every disagreement read by a person.
//
// Only judged behaviors are compared. A scenario behavior with a `check` is scored in
// code, so it is the same whichever judge runs.

/** Share of case verdicts a candidate judge must reproduce before it can replace the current one. */
export const REJUDGE_AGREEMENT_BAR = 0.95;

export type Rating = 'PASS' | 'PARTIAL' | 'MISS';

/** One behavior's rating by both judges, on one transcript. */
export interface RatingPair {
  behaviorId: string;
  /** For a scenario, which run (1-based); absent for smoke (one transcript per case). */
  run?: number;
  before: { rating: Rating; justification: string };
  after: { rating: Rating; justification: string };
}

/** One case: its gate verdict under each judge, and every rating compared. */
export interface CaseComparison {
  name: string;
  passedBefore: boolean;
  passedAfter: boolean;
  ratings: RatingPair[];
}

export interface Agreement {
  cases: number;
  verdictsAgree: number;
  ratings: number;
  ratingsAgree: number;
  /** Cases whose verdict changed — each must be reviewed. */
  verdictChanges: CaseComparison[];
  /** Cases whose verdict held but some rating changed. */
  ratingChanges: CaseComparison[];
}

export function summarize(comparisons: readonly CaseComparison[]): Agreement {
  const ratings = comparisons.flatMap(c => c.ratings);
  const changed = (c: CaseComparison): boolean => c.ratings.some(r => r.before.rating !== r.after.rating);
  return {
    cases: comparisons.length,
    verdictsAgree: comparisons.filter(c => c.passedBefore === c.passedAfter).length,
    ratings: ratings.length,
    ratingsAgree: ratings.filter(r => r.before.rating === r.after.rating).length,
    verdictChanges: comparisons.filter(c => c.passedBefore !== c.passedAfter),
    ratingChanges: comparisons.filter(c => c.passedBefore === c.passedAfter && changed(c)),
  };
}

/** True when the candidate reproduced enough verdicts to be considered (disagreements still need review). */
export function meetsBar(agreement: Agreement): boolean {
  return agreement.cases > 0 && agreement.verdictsAgree / agreement.cases >= REJUDGE_AGREEMENT_BAR;
}

/** The report lines: agreement, then every verdict change with both judges' reasons. */
export function formatAgreement(agreement: Agreement, candidate: string, baseline: string): string[] {
  const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${Math.round((n / d) * 1000) / 10}%`);
  const lines = [
    `Case verdicts:    ${agreement.verdictsAgree}/${agreement.cases} agree (${pct(agreement.verdictsAgree, agreement.cases)}; bar ${Math.round(REJUDGE_AGREEMENT_BAR * 100)}%)`,
    `Behavior ratings: ${agreement.ratingsAgree}/${agreement.ratings} agree (${pct(agreement.ratingsAgree, agreement.ratings)})`,
  ];
  const describe = (c: CaseComparison): string[] => [
    `  ${c.name}: ${baseline} ${c.passedBefore ? 'PASS' : 'FAIL'} → ${candidate} ${c.passedAfter ? 'PASS' : 'FAIL'}`,
    ...c.ratings.filter(r => r.before.rating !== r.after.rating).map(r =>
      `    ${r.behaviorId}${r.run ? ` (run ${r.run})` : ''}: ${r.before.rating} → ${r.after.rating}\n` +
      `      ${baseline}: ${r.before.justification}\n` +
      `      ${candidate}: ${r.after.justification}`),
  ];
  if (agreement.verdictChanges.length > 0) {
    lines.push('', `Verdict changes (review every one):`);
    for (const c of agreement.verdictChanges) lines.push(...describe(c));
  }
  if (agreement.ratingChanges.length > 0) {
    lines.push('', `Rating changes that kept the verdict:`);
    for (const c of agreement.ratingChanges) lines.push(...describe(c));
  }
  return lines;
}
