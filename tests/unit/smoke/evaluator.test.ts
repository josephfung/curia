// tests/unit/smoke/evaluator.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseJudgeResponse, computeWeightedScore } from '../../smoke/evaluator.js';
import type { ExpectedBehavior, BehaviorScore } from '../../smoke/types.js';

describe('Evaluator', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

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

    it('warns when judge returns an unexpected behavior ID', () => {
      const behaviors: ExpectedBehavior[] = [
        { id: 'classify-urgent', description: 'test', weight: 'critical' },
      ];
      // Judge returns underscore variant — a common reformatting mistake
      const raw = JSON.stringify({
        scores: [{ behaviorId: 'classify_urgent', rating: 'PASS', justification: 'ok' }],
      });
      parseJudgeResponse(raw, behaviors);

      const output = stderrSpy.mock.calls.map(c => String(c[0])).join('');
      expect(output).toContain("unexpected behavior ID 'classify_urgent'");
      expect(output).toContain("'classify-urgent'");
    });

    it('warns when judge omits a score for an expected behavior', () => {
      const behaviors: ExpectedBehavior[] = [
        { id: 'a', description: 'test', weight: 'important' },
        { id: 'b', description: 'test', weight: 'important' },
      ];
      const raw = JSON.stringify({
        scores: [{ behaviorId: 'a', rating: 'PASS', justification: 'ok' }],
      });
      parseJudgeResponse(raw, behaviors);

      const output = stderrSpy.mock.calls.map(c => String(c[0])).join('');
      expect(output).toContain("did not return a score for expected behavior 'b'");
    });

    it('does not warn when returned IDs match expected set exactly', () => {
      const behaviors: ExpectedBehavior[] = [
        { id: 'a', description: 'test', weight: 'important' },
      ];
      const raw = JSON.stringify({
        scores: [{ behaviorId: 'a', rating: 'PASS', justification: 'ok' }],
      });
      parseJudgeResponse(raw, behaviors);

      expect(stderrSpy).not.toHaveBeenCalled();
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

    it('warns when an expected behavior has no score entry', () => {
      const behaviors: ExpectedBehavior[] = [
        { id: 'a', description: '', weight: 'critical' },
        { id: 'b', description: '', weight: 'important' },
      ];
      // 'b' is missing from scores — simulates judge reformatting the ID
      const scores: BehaviorScore[] = [
        { behaviorId: 'a', rating: 'PASS', justification: '' },
      ];
      computeWeightedScore(behaviors, scores);

      const output = stderrSpy.mock.calls.map(c => String(c[0])).join('');
      expect(output).toContain("No score returned for behavior 'b'");
    });

    it('does not warn when all expected behaviors have scores', () => {
      const behaviors: ExpectedBehavior[] = [
        { id: 'a', description: '', weight: 'critical' },
      ];
      const scores: BehaviorScore[] = [
        { behaviorId: 'a', rating: 'PASS', justification: '' },
      ];
      computeWeightedScore(behaviors, scores);

      expect(stderrSpy).not.toHaveBeenCalled();
    });
  });
});
