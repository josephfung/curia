import { describe, it, expect } from 'vitest';
import {
  classifyTaskRisk,
  decideCompletionAction,
  parseCompletionCandidates,
  HIGH_PRIORITY_FLOOR,
} from './task-completion-risk.js';

// Fake classifier: 'restricted' when the text mentions "board" or "agm", else 'internal'.
const fakeClassify = (text: string) =>
  /board|agm/i.test(text) ? ('restricted' as const) : ('internal' as const);

describe('classifyTaskRisk', () => {
  it('marks tasks with a plan block as high-risk', () => {
    expect(
      classifyTaskRisk(
        {
          id: 't2',
          title: 'Follow up',
          priority: 40,
          tags: [],
          progress: {
            plan: {
              steps: [
                { id: 's1', taskId: '00000000-0000-4000-8000-000000000001' },
                { id: 's2', taskId: null },
              ],
              deliverableStepId: null,
              done: 0,
              total: 2,
              next: 's1',
            },
          },
        },
        fakeClassify,
      ),
    ).toBe('high');
  });

  it('marks high priority as high-risk', () => {
    expect(
      classifyTaskRisk(
        {
          id: 't5',
          title: 'Call vendor',
          priority: HIGH_PRIORITY_FLOOR,
          tags: [],
          progress: {},
        },
        () => 'internal',
      ),
    ).toBe('high');
  });

  it('marks a restricted/confidential task high-risk via the classifier', () => {
    expect(
      classifyTaskRisk(
        { id: 't', title: 'Prep board pack', priority: 40, tags: [], progress: {} },
        fakeClassify,
      ),
    ).toBe('high');
  });

  it('marks an ordinary task low-risk', () => {
    expect(
      classifyTaskRisk(
        { id: 't', title: 'Follow up with John', priority: 40, tags: [], progress: {} },
        fakeClassify,
      ),
    ).toBe('low');
  });

  it('classifies the description, not just title+tags, so a confidential body is caught', () => {
    // Generic title + tags read as low-risk; the sensitive detail lives only in the body.
    expect(
      classifyTaskRisk(
        {
          id: 't',
          title: 'Follow up',
          description: 'Send the board deck to the directors before the AGM.',
          priority: 40,
          tags: [],
          progress: {},
        },
        fakeClassify,
      ),
    ).toBe('high');
  });
});

describe('decideCompletionAction', () => {
  it('auto-completes only low-risk + high-confidence', () => {
    expect(decideCompletionAction('low', 'high')).toBe('auto_complete');
    expect(decideCompletionAction('high', 'high')).toBe('confirm');
    expect(decideCompletionAction('low', 'low')).toBe('confirm');
    expect(decideCompletionAction('high', 'low')).toBe('confirm');
  });
});

describe('parseCompletionCandidates', () => {
  it('parses pending candidates and skips asked ones', () => {
    const body = `
## Candidate — task task-a
- message_id: m1
- confidence: high
- reason: recipient+semantic
- sent_at: 2026-07-01T00:00:00.000Z
- subject: Hi
- recipients: a@example.com
- task_title: Follow up with A
- status: pending
---
## Candidate — task task-b
- message_id: m2
- confidence: low
- reason: semantic
- sent_at: 2026-07-02T00:00:00.000Z
- subject: Hi
- recipients: b@example.com
- task_title: Fuzzy thing
- status: pending
- completion_asked: {2026-07-02}
---
`;
    const parsed = parseCompletionCandidates(body);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.taskId).toBe('task-a');
    expect(parsed[0]!.confidence).toBe('high');
  });
});
