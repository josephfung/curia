// tests/smoke/gate.ts — smoke's pass/fail gate (#1956).
//
// A case passes when it ran, was judged, cleaned up after itself, scored at least
// CASE_PASS_THRESHOLD (weighted), and had no critical behavior rated MISS. The suite
// passes when every case does; the CLI exits 1 otherwise.
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
  cleanupError?: string;
}

/** Why a case fails the gate, one line each. Empty means it passes. */
export function caseFailures(c: GateInput): string[] {
  const failures: string[] = [];
  if (c.cleanupError) failures.push(`cleanup failed (leftover rows leak into later turns): ${c.cleanupError}`);
  // The scores of an errored or misjudged case are placeholders, so they say nothing
  // more about the model: report the cause only.
  if (c.error) return [`did not complete: ${c.error}`, ...failures];
  if (c.judgeError) return [`judge error (not a model failure): ${c.judgeError}`, ...failures];

  const ratings = new Map(c.scores.map(s => [s.behaviorId, s.rating]));
  for (const b of c.testCase.expectedBehaviors) {
    if (b.weight === 'critical' && ratings.get(b.id) === 'MISS') {
      failures.push(`critical behavior '${b.id}' rated MISS`);
    }
  }
  if (c.weightedScore < CASE_PASS_THRESHOLD) {
    failures.push(`weighted score ${formatPct(c.weightedScore)} is below ${formatPct(CASE_PASS_THRESHOLD)}`);
  }
  return failures;
}

export function formatPct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
