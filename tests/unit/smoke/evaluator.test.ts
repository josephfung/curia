// tests/unit/smoke/evaluator.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LLMProvider } from '../../../src/agents/llm/provider.js';
import {
  computeWeightedScore,
  evaluateCases,
  formatJudgeInput,
  parseJudgeResponse,
} from '../../smoke/evaluator.js';
import type { BehaviorScore, CaseExecution, ExpectedBehavior, TestCase } from '../../smoke/types.js';

function testCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    name: 'Case',
    description: 'A case',
    tags: [],
    sender: 'principal',
    judgeToolCalls: false,
    toolStubs: {},
    turns: [{ role: 'user', content: 'Book lunch with Dana' }],
    expectedBehaviors: [{ id: 'books', description: 'Books it', weight: 'critical' }],
    failureModes: [],
    ...overrides,
  };
}

function execution(overrides: Partial<CaseExecution> = {}): CaseExecution {
  return {
    testCase: testCase(),
    responses: [{
      content: 'Done.',
      agentId: 'coordinator',
      durationMs: 10,
      toolCalls: [{ name: 'calendar-create-event', input: { title: 'Lunch' }, result: { success: false, error: 'no calendar' } }],
    }],
    agentCalls: [],
    ...overrides,
  };
}

/** A judge whose provider answers every call with `reply` (a text body or an error type). */
function judgeReplying(...replies: Array<string | { error: string }>): { provider: LLMProvider; model: string; calls: number } {
  const state = { calls: 0 };
  const provider = {
    chat: vi.fn(async () => {
      const reply = replies[Math.min(state.calls, replies.length - 1)]!;
      state.calls++;
      return typeof reply === 'string'
        ? { type: 'text', content: reply }
        : { type: 'error', error: { type: reply.error, message: 'boom' } };
    }),
  } as unknown as LLMProvider;
  return { provider, model: 'openai/gpt-4o', get calls() { return state.calls; } };
}

describe('Evaluator', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers({ toFake: ['setTimeout'] });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    vi.useRealTimers();
  });

  describe('parseJudgeResponse', () => {
    const behaviors: ExpectedBehavior[] = [
      { id: 'a', description: 'test', weight: 'critical' },
      { id: 'b', description: 'test2', weight: 'important' },
    ];

    it('parses a well-formed judge JSON response', () => {
      const raw = JSON.stringify({
        scores: [
          { behaviorId: 'a', rating: 'PASS', justification: 'ok' },
          { behaviorId: 'b', rating: 'partial', justification: 'half' },
        ],
      });
      const { scores, error } = parseJudgeResponse(raw, behaviors);
      expect(error).toBeUndefined();
      expect(scores.map(s => s.rating)).toEqual(['PASS', 'PARTIAL']);
    });

    it('scores every behavior MISS and reports a judge error when unparseable', () => {
      const { scores, error } = parseJudgeResponse('not valid json', behaviors);
      expect(scores.map(s => s.rating)).toEqual(['MISS', 'MISS']);
      expect(error).toMatch(/unparseable/);
    });

    it('reports a skipped behavior as a judge error, not a silent MISS', () => {
      const raw = JSON.stringify({ scores: [{ behaviorId: 'a', rating: 'PASS', justification: 'ok' }] });
      const { scores, error } = parseJudgeResponse(raw, behaviors);
      expect(scores.find(s => s.behaviorId === 'b')!.rating).toBe('MISS');
      expect(error).toContain("no score for 'b'");
    });

    it('reports an invalid rating as a judge error', () => {
      const raw = JSON.stringify({
        scores: [
          { behaviorId: 'a', rating: 'GREAT', justification: '' },
          { behaviorId: 'b', rating: 'PASS', justification: '' },
        ],
      });
      expect(parseJudgeResponse(raw, behaviors).error).toContain("invalid rating 'GREAT'");
    });

    it('warns about, and ignores, a behavior ID the judge invented', () => {
      const raw = JSON.stringify({
        scores: [
          { behaviorId: 'a', rating: 'PASS', justification: '' },
          { behaviorId: 'b', rating: 'PASS', justification: '' },
          { behaviorId: 'c', rating: 'MISS', justification: '' },
        ],
      });
      const { scores, error } = parseJudgeResponse(raw, behaviors);
      expect(error).toBeUndefined();
      expect(scores).toHaveLength(2);
      const output = stderrSpy.mock.calls.map((c: unknown) => String((c as unknown[])[0])).join('');
      expect(output).toContain("unexpected behavior ID 'c'");
    });
  });

  describe('formatJudgeInput', () => {
    it('shows the reply but not the tool calls by default', () => {
      const input = formatJudgeInput(execution());
      expect(input).toContain('Done.');
      expect(input).not.toContain('calendar-create-event');
    });

    it('shows tool calls and their failures when the case opts in', () => {
      const input = formatJudgeInput(execution({ testCase: testCase({ judgeToolCalls: true }) }));
      expect(input).toContain('calendar-create-event {"title":"Lunch"}');
      expect(input).toContain('FAILED: no calendar');
    });

    it('gives the judge today\'s date, so relative dates can be checked', () => {
      expect(formatJudgeInput(execution(), undefined, 'Friday, October 2, 2026 (America/Toronto)'))
        .toContain('## Today\nFriday, October 2, 2026 (America/Toronto)');
      expect(formatJudgeInput(execution())).not.toContain('## Today');
    });

    it('names the sender', () => {
      expect(formatJudgeInput(execution(), 'Pat Example')).toContain('the principal, Pat Example');
      expect(formatJudgeInput(execution({ testCase: testCase({ sender: 'unknown' }) })))
        .toContain('unknown external sender');
    });

    it('interleaves turns with their responses', () => {
      const exec = execution({
        testCase: testCase({ turns: [{ role: 'user', content: 'first' }, { role: 'user', content: 'second' }] }),
        responses: [
          { content: 'one', agentId: 'coordinator', durationMs: 1, toolCalls: [] },
          { content: 'two', agentId: 'coordinator', durationMs: 1, toolCalls: [] },
        ],
      });
      const input = formatJudgeInput(exec);
      expect(input.indexOf('first')).toBeLessThan(input.indexOf('one'));
      expect(input.indexOf('one')).toBeLessThan(input.indexOf('second'));
      expect(input.indexOf('second')).toBeLessThan(input.indexOf('two'));
    });
  });

  describe('evaluateCases', () => {
    const pass = JSON.stringify({ scores: [{ behaviorId: 'books', rating: 'PASS', justification: 'ok' }] });

    it('passes a case the judge rates PASS', async () => {
      const [result] = await evaluateCases([execution()], judgeReplying(pass));
      expect(result!.passed).toBe(true);
      expect(result!.failures).toEqual([]);
    });

    it('does not judge a case that did not complete, and fails it with the cause', async () => {
      const judge = judgeReplying(pass);
      const [result] = await evaluateCases([execution({ error: 'Timeout waiting for the coordinator (120s)' })], judge);
      expect(judge.calls).toBe(0);
      expect(result!.passed).toBe(false);
      expect(result!.failures).toEqual(['did not complete: Timeout waiting for the coordinator (120s)']);
    });

    it('retries a transient judge failure', async () => {
      const judge = judgeReplying({ error: 'TIMEOUT' }, pass);
      const pending = evaluateCases([execution()], judge);
      await vi.runAllTimersAsync();
      const [result] = await pending;
      expect(judge.calls).toBe(2);
      expect(result!.passed).toBe(true);
    });

    it('reports a judge that keeps failing as a judge error, not a model failure', async () => {
      const judge = judgeReplying({ error: 'PROVIDER_ERROR' });
      const pending = evaluateCases([execution()], judge);
      await vi.runAllTimersAsync();
      const [result] = await pending;
      expect(result!.judgeError).toMatch(/failed after 3 attempts/);
      expect(result!.failures[0]).toMatch(/^judge error \(not a model failure\)/);
    });

    it('aborts on a judge error that would repeat on every case', async () => {
      await expect(evaluateCases([execution()], judgeReplying({ error: 'AUTH_ERROR' })))
        .rejects.toThrow(/Judge call failed \(AUTH_ERROR\)/);
    });

    it('carries every agent\'s tool calls into the result', async () => {
      const agentCalls = [{ agentId: 'calendar', toolName: 'calendar-list-events', input: {}, disposition: 'stubbed' as const, success: true }];
      const [result] = await evaluateCases([execution({ agentCalls })], judgeReplying(pass));
      expect(result!.agentCalls).toEqual(agentCalls);
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
      const behaviors: ExpectedBehavior[] = [{ id: 'a', description: '', weight: 'critical' }];
      const scores: BehaviorScore[] = [{ behaviorId: 'a', rating: 'MISS', justification: '' }];
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
      const scores: BehaviorScore[] = [{ behaviorId: 'a', rating: 'PASS', justification: '' }];
      computeWeightedScore(behaviors, scores);

      const output = stderrSpy.mock.calls.map((c: unknown) => String((c as unknown[])[0])).join('');
      expect(output).toContain("No score entry for behavior 'b'");
    });
  });
});
