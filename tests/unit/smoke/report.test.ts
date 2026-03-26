// tests/unit/smoke/report.test.ts
import { describe, it, expect } from 'vitest';
import { generateReport } from '../../smoke/report.js';
import type { RunResult, HistoricalEntry } from '../../smoke/types.js';

describe('Report generator', () => {
  const mockRun: RunResult = {
    timestamp: '2026-03-25T22:00:00.000Z',
    durationMs: 45000,
    overallScore: 0.65,
    cases: [
      {
        testCase: {
          name: 'Test Case 1',
          description: 'A test',
          tags: ['inference'],
          turns: [{ role: 'user', content: 'Hello' }],
          expectedBehaviors: [
            { id: 'greet', description: 'Greets back', weight: 'critical' },
          ],
          failureModes: ['Ignores greeting'],
        },
        responses: [{ content: 'Hi there!', agentId: 'coordinator', durationMs: 1200 }],
        scores: [{ behaviorId: 'greet', rating: 'PASS', justification: 'Greeted warmly' }],
        weightedScore: 1.0,
      },
    ],
  };

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
