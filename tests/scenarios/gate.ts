// tests/scenarios/gate.ts — pass rates and the release gate.
import { sumBreakdowns } from '../shared/usage.js';
import {
  BEHAVIOR_LAYERS,
  CRITICAL_PASS_THRESHOLD,
  RATING_VALUES,
  WEIGHT_VALUES,
  type BehaviorLayer,
  type BehaviorResult,
  type LayerScore,
  type CaseResult,
  type ExpectedBehavior,
  type RunRating,
  type ScenarioRun,
} from './types.js';

export function passRate(ratings: RunRating[]): number {
  if (ratings.length === 0) return 0;
  return ratings.reduce((sum, r) => sum + RATING_VALUES[r.rating], 0) / ratings.length;
}

/** Share of ratings that are a full PASS — what the critical gate counts. */
export function strictPassRate(ratings: RunRating[]): number {
  if (ratings.length === 0) return 0;
  return ratings.filter(r => r.rating === 'PASS').length / ratings.length;
}

/** Σ(weight × passRate) / Σweight; 0 for no behaviors. */
function weightedScore(results: BehaviorResult[]): number {
  const totalWeight = results.reduce((s, r) => s + WEIGHT_VALUES[r.behavior.weight], 0);
  const earned = results.reduce((s, r) => s + WEIGHT_VALUES[r.behavior.weight] * r.passRate, 0);
  return totalWeight === 0 ? 0 : earned / totalWeight;
}

function criticalFailures(results: BehaviorResult[]): string[] {
  return results
    .filter(r => r.behavior.weight === 'critical' && r.strictPassRate < CRITICAL_PASS_THRESHOLD)
    .map(r => r.behavior.id);
}

/**
 * The per-layer summary for the cases that have layers (#2556): each layer's mean score over
 * the cases that use it, and how many of those cases failed a critical behavior in it.
 * Empty when no case has layers.
 */
export function layerSummaryLines(cases: CaseResult[]): string[] {
  const lines: string[] = [];
  for (const layer of BEHAVIOR_LAYERS) {
    const scored = cases.flatMap(c => (c.layers?.[layer] ? [c.layers[layer]] : []));
    if (scored.length === 0) continue;
    const mean = scored.reduce((s, l) => s + l.weightedScore, 0) / scored.length;
    const failed = scored.filter(l => l.criticalFailures.length > 0).length;
    lines.push(`${layer.padEnd(8)} ${formatPct(mean).padStart(4)} mean over ${scored.length} case(s); ${failed} failed a critical ${layer} behavior`);
  }
  return lines;
}

/** "decision 80% · voice 55% FAIL": a case's layer scores for its summary line; '' without layers. */
export function formatCaseLayers(c: CaseResult): string {
  if (!c.layers) return '';
  return BEHAVIOR_LAYERS.flatMap(layer => {
    const l = c.layers![layer];
    return l ? [`${layer} ${formatPct(l.weightedScore)}${l.criticalFailures.length > 0 ? ' FAIL' : ''}`] : [];
  }).join(' · ');
}

/** Marks a rating the judge could not produce (an infrastructure failure, not the model's). */
export const JUDGE_ERROR_PREFIX = 'judge error';

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
  knownFailure?: { issue: string; reason: string },
): CaseResult {
  const results: BehaviorResult[] = behaviors.map(behavior => {
    const ratings = ratingsByBehavior.get(behavior.id) ?? [];
    if (ratings.length !== runs.length) {
      throw new Error(
        `${name}: behavior '${behavior.id}' has ${ratings.length} rating(s) for ${runs.length} run(s)`,
      );
    }
    return { behavior, ratings, passRate: passRate(ratings), strictPassRate: strictPassRate(ratings) };
  });

  const layers: Partial<Record<BehaviorLayer, LayerScore>> = {};
  for (const layer of BEHAVIOR_LAYERS) {
    const own = results.filter(r => r.behavior.layer === layer);
    if (own.length > 0) layers[layer] = { weightedScore: weightedScore(own), criticalFailures: criticalFailures(own) };
  }

  return {
    name,
    runs,
    behaviors: results,
    weightedScore: weightedScore(results),
    criticalFailures: criticalFailures(results),
    ...(Object.keys(layers).length > 0 ? { layers } : {}),
    ...(knownFailure ? { knownFailure } : {}),
    // Counted per run, not per behavior: one judge failure misses every judged behavior.
    judgeErrors: runs.filter((_, i) =>
      results.some(r => r.ratings[i]!.justification.startsWith(JUDGE_ERROR_PREFIX)),
    ).length,
    usage: sumBreakdowns(runs.map(r => r.usage)),
  };
}

/** Reasons the suite fails, one line each. Empty means the gate passes. */
export function gateFailures(cases: CaseResult[]): string[] {
  const failures: string[] = [];
  for (const c of cases) {
    // A known failure is reported by knownFailureLines, not gated. Everything below it
    // (judge errors, cleanup, errored runs) still gates: those are not the tracked bug.
    for (const id of c.knownFailure ? [] : c.criticalFailures) {
      const result = c.behaviors.find(b => b.behavior.id === id)!;
      failures.push(
        `${c.name}: critical behavior '${id}' fully passed ${formatPct(result.strictPassRate)} of runs ` +
        `(needs ${formatPct(CRITICAL_PASS_THRESHOLD)})`,
      );
    }
    // The judge failing is not the model failing. Its MISSes already count against the
    // pass rate, so say so separately — otherwise it reads as a model regression.
    if (c.judgeErrors > 0) {
      failures.push(`${c.name}: the judge errored on ${c.judgeErrors} run(s) — those behaviors were not measured`);
    }
    const leftovers = c.runs.filter(r => r.cleanupError);
    if (leftovers.length > 0) {
      failures.push(`${c.name}: cleanup failed on ${leftovers.length} run(s) — ${leftovers[0]!.cleanupError}`);
    }
    // A run that errored (timeout, agent.error) was rated MISS on every behavior, so it
    // already counts against the pass rate. Report it as well: "the model got it wrong"
    // and "the run never finished" need different fixes. So do a stuck run and one whose
    // wait ran out while a real specialist was still working (#2027).
    const errored = c.runs.filter(r => r.error && r.timeoutKind !== 'delegate_wait');
    if (errored.length > 0) {
      failures.push(`${c.name}: ${errored.length} run(s) errored — ${errored[0]!.error}`);
    }
    const slow = c.runs.filter(r => r.error && r.timeoutKind === 'delegate_wait');
    if (slow.length > 0) {
      failures.push(`${c.name}: ${slow.length} run(s) timed out on a slow specialist, not a stuck run — ${slow[0]!.error}`);
    }
  }
  return failures;
}

export function formatPct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Critical failures in cases marked known_failure, one line each — reported, not gated. */
export function knownFailureLines(cases: CaseResult[]): string[] {
  return cases.flatMap(c => (c.knownFailure ? c.criticalFailures : []).map(id => {
    const result = c.behaviors.find(b => b.behavior.id === id)!;
    return `${c.name}: '${id}' fully passed ${formatPct(result.strictPassRate)} of runs — known failure ${c.knownFailure!.issue}`;
  }));
}

/**
 * A case marked known_failure whose critical behaviors all cleared: the marker may be
 * stale. A warning, not a failure — one good run is not proof — but it must be seen.
 */
export function staleKnownFailures(cases: CaseResult[]): string[] {
  return cases
    .filter(c => c.knownFailure && c.criticalFailures.length === 0 && c.runs.every(r => !r.error))
    .map(c => `${c.name} is marked known_failure (${c.knownFailure!.issue}) but passed its critical behaviors — remove the marker if it holds`);
}
