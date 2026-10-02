// tests/unit/smoke/report.test.ts
import { describe, it, expect } from 'vitest';
import { generateReport } from '../../smoke/report.js';
import type { RunResult, HistoricalEntry } from '../../smoke/types.js';

describe('Report generator', () => {
  const mockRun: RunResult = {
    timestamp: '2026-03-25T22:00:00.000Z',
    model: 'deepseek/deepseek-v4.1-flash',
    commit: 'abc1234',
    filtered: false,
    durationMs: 45000,
    overallScore: 0.65,
    passed: false,
    cases: [
      {
        testCase: {
          name: 'Test Case 1',
          description: 'A test',
          tags: ['inference'],
          sender: 'principal',
          judgeToolCalls: false,
          toolStubs: {},
          turns: [{ role: 'user', content: 'Hello' }],
          expectedBehaviors: [
            { id: 'greet', description: 'Greets back', weight: 'critical' },
          ],
          failureModes: ['Ignores greeting'],
        },
        responses: [{
          prompt: 'Hello',
          content: 'Hi there!',
          agentId: 'coordinator',
          durationMs: 1200,
          toolCalls: [{ name: 'contact-lookup', input: {}, result: { success: false, error: 'nope' } }],
        }],
        scores: [{ behaviorId: 'greet', rating: 'PASS', justification: 'Greeted warmly' }],
        weightedScore: 1.0,
        agentCalls: [],
        passed: true,
        failures: [],
      },
      {
        testCase: {
          name: 'Test Case 2',
          description: 'Another',
          tags: [],
          sender: 'unknown',
          judgeToolCalls: false,
          toolStubs: {},
          turns: [{ role: 'user', content: 'Who are you?' }],
          expectedBehaviors: [{ id: 'careful', description: 'Is careful', weight: 'critical' }],
          failureModes: [],
        },
        responses: [],
        scores: [{ behaviorId: 'careful', rating: 'MISS', justification: 'Timed out' }],
        weightedScore: 0,
        error: 'Timeout',
        agentCalls: [],
        passed: false,
        failures: ['did not complete: Timeout'],
      },
    ],
  };

  it('shows the gate failures and the tools a turn called', () => {
    const html = generateReport(mockRun);
    expect(html).toContain('did not complete: Timeout');
    expect(html).toContain('contact-lookup (failed)');
  });

  it('labels each case with the gate verdict, including retries and known failures', () => {
    const [first, second] = mockRun.cases;
    const html = generateReport({
      ...mockRun,
      cases: [
        { ...first!, firstAttempt: { weightedScore: 0.4, failures: ['weighted score 40% is below 80%'] } },
        { ...second!, error: undefined, failures: ['critical behavior \'careful\' rated MISS'], testCase: { ...second!.testCase, knownFailure: { issue: '#1975' } } },
      ],
    });
    expect(html).toContain('PASS*');
    expect(html).toContain('First attempt 40%');
    expect(html).toContain('KNOWN #1975');
  });

  it('generates valid HTML with required sections', () => {
    const html = generateReport(mockRun);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Curia Smoke Test Report');
    expect(html).toContain('Test Case 1');
    expect(html).toContain('65%');
    expect(html).toContain('PASS');
  });

  it('includes historical trend data when provided', () => {
    const history: HistoricalEntry[] = [
      { timestamp: '2026-03-20T00:00:00Z', overallScore: 0.4, caseCount: 10, passRate: 0.3 },
      { timestamp: '2026-03-25T00:00:00Z', overallScore: 0.65, caseCount: 14, passRate: 0.5 },
    ];
    const html = generateReport(mockRun, history);
    expect(html).toContain('Trend');
    expect(html).toContain('40%');
  });

  it('color-codes PASS/PARTIAL/MISS', () => {
    const html = generateReport(mockRun);
    expect(html).toMatch(/pass|green|#22c55e/i);
  });
});
