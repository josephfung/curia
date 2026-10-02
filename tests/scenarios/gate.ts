// tests/scenarios/gate.ts — pass rates and the release gate.
import {
  CRITICAL_PASS_THRESHOLD,
  RATING_VALUES,
  WEIGHT_VALUES,
  type BehaviorResult,
  type CaseResult,
  type ExpectedBehavior,
  type RunRating,
  type ScenarioRun,
} from './types.js';

export function passRate(ratings: RunRating[]): number {
  if (ratings.length === 0) return 0;
  return ratings.reduce((sum, r) => sum + RATING_VALUES[r.rating], 0) / ratings.length;
}

/**
 * Fold per-run ratings into a case result. `ratingsByBehavior` must hold one rating per
 * run for every behavior; a missing one is a harness bug, so it throws rather than
 * scoring a silent MISS (or worse, a silent pass).
 */
export function scoreCase(
  name: string,
  behaviors: ExpectedBehavior[],
  runs: ScenarioRun[],
  ratingsByBehavior: Map<string, RunRating[]>,
): CaseResult {
  const results: BehaviorResult[] = behaviors.map(behavior => {
    const ratings = ratingsByBehavior.get(behavior.id) ?? [];
    if (ratings.length !== runs.length) {
      throw new Error(
        `${name}: behavior '${behavior.id}' has ${ratings.length} rating(s) for ${runs.length} run(s)`,
      );
    }
    return { behavior, ratings, passRate: passRate(ratings) };
  });

  const totalWeight = results.reduce((s, r) => s + WEIGHT_VALUES[r.behavior.weight], 0);
  const earned = results.reduce((s, r) => s + WEIGHT_VALUES[r.behavior.weight] * r.passRate, 0);

  return {
    name,
    runs,
    behaviors: results,
    weightedScore: totalWeight === 0 ? 0 : earned / totalWeight,
    criticalFailures: results
      .filter(r => r.behavior.weight === 'critical' && r.passRate < CRITICAL_PASS_THRESHOLD)
      .map(r => r.behavior.id),
  };
}

/** Reasons the suite fails, one line each. Empty means the gate passes. */
export function gateFailures(cases: CaseResult[]): string[] {
  const failures: string[] = [];
  for (const c of cases) {
    for (const id of c.criticalFailures) {
      const result = c.behaviors.find(b => b.behavior.id === id)!;
      failures.push(
        `${c.name}: critical behavior '${id}' passed ${formatPct(result.passRate)} of runs ` +
        `(needs ${formatPct(CRITICAL_PASS_THRESHOLD)})`,
      );
    }
    // A run that errored (timeout, agent.error) was rated MISS on every behavior, so it
    // already counts against the pass rate. Report it as well: "the model got it wrong"
    // and "the run never finished" need different fixes.
    const errored = c.runs.filter(r => r.error);
    if (errored.length > 0) {
      failures.push(`${c.name}: ${errored.length} run(s) errored — ${errored[0]!.error}`);
    }
  }
  return failures;
}

export function formatPct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
