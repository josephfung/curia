// tests/unit/smoke/evaluator.test.ts
import { describe, it, expect } from 'vitest';
import { parseJudgeResponse, computeWeightedScore } from '../../smoke/evaluator.js';
import type { ExpectedBehavior, BehaviorScore } from '../../smoke/types.js';

describe('Evaluator', () => {
  describe('parseJudgeResponse', () => {
    it('parses a well-formed judge JSON response', () => {
      const raw = JSON.stringify({
        scores: [
          { behaviorId: 'detect-expense', rating: 'PASS', justification: 'Clearly identified as receipt' },
          { behaviorId: 'extract-amount', rating: 'PARTIAL', justification: 'Got the amount but wrong currency' },
          { behaviorId: 'categorize', rating: 'MISS', justification: 'No categorization attempted' },
        ],
      });

      const scores = parseJudgeResponse(raw);
      expect(scores).toHaveLength(3);
      expect(scores[0]!.rating).toBe('PASS');
      expect(scores[1]!.rating).toBe('PARTIAL');
      expect(scores[2]!.rating).toBe('MISS');
    });

    it('returns MISS for all behaviors if response is unparseable', () => {
      const behaviors: ExpectedBehavior[] = [
        { id: 'a', description: 'test', weight: 'critical' },
        { id: 'b', description: 'test2', weight: 'important' },
      ];
      const scores = parseJudgeResponse('not valid json', behaviors);
      expect(scores).toHaveLength(2);
      expect(scores.every(s => s.rating === 'MISS')).toBe(true);
    });
  });

  describe('computeWeightedScore', () => {
    it('returns 1.0 for all PASS', () => {
      const behaviors: ExpectedBehavior[] = [
        { id: 'a', description: '', weight: 'critical' },
        { id: 'b', description: '', weight: 'important' },
      ];
      const scores: BehaviorScore[] = [
        { behaviorId: 'a', rating: 'PASS', justification: '' },
        { behaviorId: 'b', rating: 'PASS', justification: '' },
      ];
      expect(computeWeightedScore(behaviors, scores)).toBeCloseTo(1.0);
    });

    it('returns 0.0 for all MISS', () => {
      const behaviors: ExpectedBehavior[] = [
        { id: 'a', description: '', weight: 'critical' },
      ];
      const scores: BehaviorScore[] = [
        { behaviorId: 'a', rating: 'MISS', justification: '' },
      ];
      expect(computeWeightedScore(behaviors, scores)).toBeCloseTo(0.0);
    });

    it('weights critical higher than nice-to-have', () => {
      const behaviors: ExpectedBehavior[] = [
        { id: 'a', description: '', weight: 'critical' },
        { id: 'b', description: '', weight: 'nice-to-have' },
      ];
      // critical PASS (3*1.0=3), nice-to-have MISS (1*0.0=0), total=3/4=0.75
      const scores: BehaviorScore[] = [
        { behaviorId: 'a', rating: 'PASS', justification: '' },
        { behaviorId: 'b', rating: 'MISS', justification: '' },
      ];
      expect(computeWeightedScore(behaviors, scores)).toBeCloseTo(0.75);
    });
  });
});
