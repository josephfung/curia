// tests/smoke/gate.ts — smoke's pass/fail gate (#1956).
//
// A case passes when it ran, was judged, scored at least CASE_PASS_THRESHOLD
// (weighted), and had no critical behavior rated MISS. The suite passes when every case
// does, apart from cases marked known_failure (a tracked bug); the CLI exits 1 otherwise.
//
// Each gating failure is run once more (cli.ts) and fails only if the retry fails too:
// a single run swings a lot on the same code (one case scored 94% then 38%), and a
// release gate that blocks at random teaches people to ignore it. A behavior that fails
// half the time still fails both attempts a quarter of the time, and the report marks
// every case that needed a retry.
//
// Why both conditions: the weighted score alone lets one critical MISS hide behind
// enough passes (five critical PASS and one critical MISS is 83%), and a critical
// behavior is by definition one whose absence is a regression.
import { CASE_PASS_THRESHOLD, type BehaviorScore, type TestCase } from './types.js';

export interface GateInput {
  testCase: TestCase;
  scores: BehaviorScore[];
  weightedScore: number;
  error?: string;
  judgeError?: string;
}

/** Why a case fails the gate, one line each. Empty means it passes. */
export function caseFailures(c: GateInput): string[] {
  // The scores of an errored or misjudged case are placeholders, so they say nothing
  // more about the model: report the cause only.
  if (c.error) return [`did not complete: ${c.error}`];
  if (c.judgeError) return [`judge error (not a model failure): ${c.judgeError}`];

  const failures: string[] = [];
  const ratings = new Map(c.scores.map(s => [s.behaviorId, s.rating]));
  for (const b of c.testCase.expectedBehaviors) {
    if (b.weight === 'critical' && ratings.get(b.id) === 'MISS') {
      failures.push(`critical behavior '${b.id}' rated MISS`);
    }
  }
  if (c.weightedScore < CASE_PASS_THRESHOLD) {
    // Rounded down, so 79.5% never reads as "80% is below 80%".
    failures.push(`weighted score ${Math.floor(c.weightedScore * 100)}% is below ${formatPct(CASE_PASS_THRESHOLD)}`);
  }
  return failures;
}

/**
 * Cases that fail the gate. A known_failure case is left out only when the model failed
 * it: an execution or judge error says nothing about whether its bug is still there.
 */
export function gatingFailures<T extends { passed: boolean; error?: string; judgeError?: string; testCase: TestCase }>(cases: T[]): T[] {
  return cases.filter(c => !c.passed && (!c.testCase.knownFailure || c.error !== undefined || c.judgeError !== undefined));
}

/** known_failure cases that passed: the bug may be fixed, so the marker may be stale. */
export function staleKnownFailures<T extends { passed: boolean; testCase: TestCase }>(cases: T[]): T[] {
  return cases.filter(c => c.passed && c.testCase.knownFailure);
}

/**
 * Fold a retry pass into the first pass's results. A retried case takes its retry's
 * result (passing if the retry passed) and keeps what the first attempt said, so the
 * report shows a case that needed a second chance. Order follows `first`.
 */
export function mergeRetries<T extends { testCase: TestCase; weightedScore: number; failures: string[]; firstAttempt?: { weightedScore: number; failures: string[] } }>(
  first: T[],
  retries: T[],
): T[] {
  const byName = new Map(retries.map(r => [r.testCase.name, r]));
  return first.map((c) => {
    const retry = byName.get(c.testCase.name);
    return retry ? { ...retry, firstAttempt: { weightedScore: c.weightedScore, failures: c.failures } } : c;
  });
}

export function formatPct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
