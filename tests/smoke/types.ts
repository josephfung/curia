// tests/smoke/types.ts
import type { ObservedToolCall } from '../shared/turn-capture.js';

// -- Test case definition (loaded from YAML) --

export type BehaviorWeight = 'critical' | 'important' | 'nice-to-have';

export interface ExpectedBehavior {
  id: string;
  description: string;
  weight: BehaviorWeight;
}

export interface Turn {
  role: 'user';
  content: string;
  /** Delay before sending this turn (ms). Simulates pauses in multi-turn. */
  delayMs?: number;
}

/**
 * Who sends the case's turns.
 * - principal: the principal on the local `smoke-test` channel (the default).
 * - unknown: an email address with no contact record — the low-trust path.
 */
export type SmokeSender = 'principal' | 'unknown';
export const SMOKE_SENDERS: readonly SmokeSender[] = ['principal', 'unknown'];

export interface TestCase {
  name: string;
  description: string;
  tags: string[];
  sender: SmokeSender;
  /** Show the judge each turn's tool calls and results, not only the reply text. */
  judgeToolCalls: boolean;
  turns: Turn[];
  expectedBehaviors: ExpectedBehavior[];
  failureModes: string[];
}

// -- Execution results --

export interface CapturedResponse {
  content: string;
  agentId: string;
  durationMs: number;
  /** The coordinator's tool calls during this turn, in order. */
  toolCalls: ObservedToolCall[];
}

export interface CaseExecution {
  testCase: TestCase;
  responses: CapturedResponse[];
  error?: string;
  /** Set when deleting the case's conversation rows failed; leftovers may remain. */
  cleanupError?: string;
}

// -- Evaluation results --

export type BehaviorRating = 'PASS' | 'PARTIAL' | 'MISS';

export interface BehaviorScore {
  behaviorId: string;
  rating: BehaviorRating;
  justification: string;
}

export interface CaseResult {
  testCase: TestCase;
  responses: CapturedResponse[];
  scores: BehaviorScore[];
  /** Weighted score 0-1 for this case */
  weightedScore: number;
  error?: string;
  /** The judge failed (not the model): its scores are placeholders. Gated separately. */
  judgeError?: string;
  cleanupError?: string;
  /** The case clears the gate (gate.ts). */
  passed: boolean;
  /** Why it did not, one line each; empty when it passed. */
  failures: string[];
}

// -- Run-level results --

export interface RunResult {
  timestamp: string; // ISO 8601
  /** The model every agent ran on (--model), or null for the configured routing. */
  model: string | null;
  /** The commit the run started on, for the release pre-flight record. */
  commit: string;
  /** True when --case / --tags narrowed the run — a passing filtered run is not a release gate. */
  filtered: boolean;
  cases: CaseResult[];
  /** Overall weighted score 0-1 across all cases */
  overallScore: number;
  /** The suite passes when every case passes. */
  passed: boolean;
  durationMs: number;
}

// -- Historical tracking --

export interface HistoricalEntry {
  timestamp: string;
  overallScore: number;
  caseCount: number;
  passRate: number; // fraction of behaviors rated PASS
}

// -- Scoring constants --

export const WEIGHT_VALUES: Record<BehaviorWeight, number> = {
  critical: 3,
  important: 2,
  'nice-to-have': 1,
};

export const RATING_VALUES: Record<BehaviorRating, number> = {
  PASS: 1.0,
  PARTIAL: 0.5,
  MISS: 0.0,
};

/**
 * The gate (gate.ts): a case passes at this weighted score or above, with no critical
 * behavior rated MISS. Matches the CLI's long-standing PASS label (≥ 80%).
 */
export const CASE_PASS_THRESHOLD = 0.8;
