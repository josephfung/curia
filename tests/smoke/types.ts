// tests/smoke/types.ts

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

export interface TestCase {
  name: string;
  description: string;
  tags: string[];
  turns: Turn[];
  expectedBehaviors: ExpectedBehavior[];
  failureModes: string[];
}

// -- Execution results --

export interface CapturedResponse {
  content: string;
  agentId: string;
  durationMs: number;
}

export interface CaseExecution {
  testCase: TestCase;
  responses: CapturedResponse[];
  error?: string;
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
}

// -- Run-level results --

export interface RunResult {
  timestamp: string; // ISO 8601
  cases: CaseResult[];
  /** Overall weighted score 0-1 across all cases */
  overallScore: number;
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
