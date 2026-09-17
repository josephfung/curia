// late-delegation.test.ts — classification and rendering for late specialist responses (#1799).
//
// One case per row of the disposition matrix in the issue: the classifier is what decides
// whether a late result gets acted on or handed to a human, and it must reach the same verdict
// live (subscriber) as it does on restart recovery (sweep).

import { describe, it, expect } from 'vitest';
import {
  abandonedClassification,
  capResult,
  classifyLateResponse,
  computeLateDeliveryExpiry,
  formatDeliveredAt,
  parseSchedulerJobId,
  renderLateNote,
  type LateResponseFacts,
} from './late-delegation.js';
import { EXECUTION_PAUSED_PROTOCOL } from './resumable-task.js';

function facts(overrides: Partial<LateResponseFacts> = {}): LateResponseFacts {
  return {
    payload: { agentId: 'calendar', conversationId: 'delegate-1', content: 'Trip: YYZ→SFO Oct 2' },
    originChannelId: 'scheduler',
    reviewTaskStatus: 'open',
    ...overrides,
  };
}

describe('classifyLateResponse (#1799)', () => {
  it('treats a normal late result from a routable origin as deliverable', () => {
    const c = classifyLateResponse(facts());
    expect(c.disposition).toBe('deliverable');
    expect(c.resolution).toBe('annotated_result');
  });

  it('classifies a structured specialist failure as an error with its reason', () => {
    const c = classifyLateResponse(facts({
      payload: { content: 'budget exhausted', isError: true, reason: 'maxTurns' },
    }));
    expect(c.disposition).toBe('error');
    expect(c.resolution).toBe('annotated_error');
    expect(c.failureReason).toBe('maxTurns');
  });

  it('falls back to an unknown reason when isError carries no structured reason', () => {
    const c = classifyLateResponse(facts({ payload: { content: 'boom', isError: true } }));
    expect(c.disposition).toBe('error');
    expect(c.failureReason).toBe('unknown');
  });

  it('treats a clarification request as a question, not a result', () => {
    const c = classifyLateResponse(facts({
      payload: {
        content: JSON.stringify({
          _curia_protocol: 'clarification_request',
          question: 'Which calendar?',
          context: 'found two',
          resume_token: 'abc',
        }),
      },
    }));
    expect(c.disposition).toBe('clarification');
    expect(c.resolution).toBe('annotated_clarification');
  });

  it('leaves a paused specialist to the resumable continuation path', () => {
    const c = classifyLateResponse(facts({
      payload: {
        content: JSON.stringify({
          _curia_protocol: EXECUTION_PAUSED_PROTOCOL,
          done: 3,
          total: 10,
          next: 'keep going',
          last_slice_units: 3,
          task_id: 'task-1',
        }),
      },
    }));
    expect(c.disposition).toBe('paused');
    expect(c.resolution).toBe('annotated_paused');
  });

  it('marks a nested delegation (internal origin channel) unroutable', () => {
    const c = classifyLateResponse(facts({ originChannelId: 'internal' }));
    expect(c.disposition).toBe('unroutable');
    expect(c.resolution).toBe('annotated_unroutable');
  });

  it('does NOT mark a scheduler origin unroutable — that is the case this exists to rescue', () => {
    expect(classifyLateResponse(facts({ originChannelId: 'scheduler' })).disposition).toBe('deliverable');
  });

  for (const status of ['done', 'cancelled', 'failed']) {
    it(`defers to a human who already left the review task '${status}'`, () => {
      const c = classifyLateResponse(facts({ reviewTaskStatus: status }));
      expect(c.disposition).toBe('review_closed');
      expect(c.resolution).toBe('annotated_review_closed');
    });
  }

  it('a closed review task wins over every other signal, including an errored response', () => {
    const c = classifyLateResponse(facts({
      reviewTaskStatus: 'cancelled',
      payload: { content: 'failed', isError: true, reason: 'api_error' },
    }));
    expect(c.disposition).toBe('review_closed');
  });

  it('classifies normally when there is no review task at all', () => {
    expect(classifyLateResponse(facts({ reviewTaskStatus: null })).disposition).toBe('deliverable');
  });

  it('treats a non-JSON body as a plain result, not a protocol payload', () => {
    expect(classifyLateResponse(facts({ payload: { content: 'just text {not json' } })).disposition)
      .toBe('deliverable');
  });

  it('treats a JSON body with no protocol marker as a plain result', () => {
    const c = classifyLateResponse(facts({ payload: { content: JSON.stringify({ trips: [] }) } }));
    expect(c.disposition).toBe('deliverable');
  });
});

describe('parseSchedulerJobId (#1799)', () => {
  it('extracts the job id from a per-run scheduler conversation', () => {
    expect(parseSchedulerJobId('scheduler:cff7f3bb-1111-2222-3333-444455556666:run-9'))
      .toBe('cff7f3bb-1111-2222-3333-444455556666');
  });

  it('extracts the job id from a two-segment scheduler conversation', () => {
    expect(parseSchedulerJobId('scheduler:job-1')).toBe('job-1');
  });

  it('returns undefined for non-scheduler conversations', () => {
    expect(parseSchedulerJobId('delegate-abc')).toBeUndefined();
    expect(parseSchedulerJobId('signal:+15551234567')).toBeUndefined();
    expect(parseSchedulerJobId('scheduler')).toBeUndefined();
    expect(parseSchedulerJobId('scheduler:')).toBeUndefined();
  });
});

describe('computeLateDeliveryExpiry (#1799)', () => {
  const now = new Date('2026-09-14T12:00:00.000Z');

  it('uses the configured TTL when it exceeds twice the elapsed wait', () => {
    const expiry = computeLateDeliveryExpiry(now, 60, 90_000);
    expect(expiry.toISOString()).toBe('2026-09-14T13:00:00.000Z');
  });

  it('floors at twice the wait for a long delegation window', () => {
    // A 12.5-minute wait (the widened window from #1310) doubles to 25 min — still under the
    // 60-minute TTL, so the TTL wins.
    expect(computeLateDeliveryExpiry(now, 60, 750_000).toISOString()).toBe('2026-09-14T13:00:00.000Z');
    // A 45-minute wait doubles to 90 min, which beats the TTL.
    expect(computeLateDeliveryExpiry(now, 60, 2_700_000).toISOString()).toBe('2026-09-14T13:30:00.000Z');
  });

  it('ignores a missing or nonsensical wait', () => {
    expect(computeLateDeliveryExpiry(now, 30).toISOString()).toBe('2026-09-14T12:30:00.000Z');
    expect(computeLateDeliveryExpiry(now, 30, -5).toISOString()).toBe('2026-09-14T12:30:00.000Z');
    expect(computeLateDeliveryExpiry(now, 30, Number.NaN).toISOString()).toBe('2026-09-14T12:30:00.000Z');
  });
});

describe('capResult (#1799)', () => {
  it('leaves a short result untouched', () => {
    expect(capResult('short', 100)).toBe('short');
  });

  it('marks the cut and says where the full text lives', () => {
    const capped = capResult('x'.repeat(50), 10);
    expect(capped.startsWith('x'.repeat(10))).toBe(true);
    expect(capped).toContain('truncated 40 chars');
    expect(capped).toContain('audit event');
  });
});

describe('renderLateNote (#1799)', () => {
  const base = { targetAgent: 'calendar', maxResultChars: 100, deliveredAtDisplay: '2026-09-14T12:06:43-04:00' };

  it('includes the result and states that follow-up has not run, for a deliverable', () => {
    const note = renderLateNote({
      ...base,
      classification: classifyLateResponse(facts()),
      content: 'Trip: YYZ→SFO Oct 2',
    });
    expect(note).toContain('Trip: YYZ→SFO Oct 2');
    expect(note).toContain('2026-09-14T12:06:43-04:00');
    expect(note).toContain('have NOT run yet');
  });

  it('does not restate the original delegated brief (#1064 re-execution precedent)', () => {
    // The note lands on a task description a coordinator may later read. Echoing the original
    // instruction is what made the drift-pause notice re-execute the work it was reporting on.
    const brief = 'Detect travel from the calendar and create trip tasks';
    const note = renderLateNote({
      ...base,
      classification: classifyLateResponse(facts()),
      content: 'Found 1 trip',
    });
    expect(note).not.toContain(brief);
  });

  it('says plainly that the work did not happen when the specialist errored', () => {
    const note = renderLateNote({
      ...base,
      classification: classifyLateResponse(facts({
        payload: { content: 'nope', isError: true, reason: 'maxTurns' },
      })),
      content: 'nope',
    });
    expect(note).toContain('maxTurns');
    expect(note).toContain('did not happen');
  });

  it('carries the question through for a clarification', () => {
    const content = JSON.stringify({
      _curia_protocol: 'clarification_request',
      question: 'Which calendar?',
      context: 'two found',
      resume_token: 'tok',
    });
    const note = renderLateNote({
      ...base,
      classification: classifyLateResponse(facts({ payload: { content } })),
      content,
    });
    expect(note).toContain('needing a decision');
    expect(note).toContain('Which calendar?');
  });

  it('states the waiting window and that nothing arrived, for an abandoned handle', () => {
    const note = renderLateNote({
      targetAgent: 'calendar',
      classification: abandonedClassification(60),
      maxResultChars: 100,
      ttlMinutes: 60,
    });
    expect(note).toContain('never delivered');
    expect(note).toContain('60 minutes');
    expect(note).toContain('not started');
  });

  it('renders an abandoned note without a TTL when none is supplied', () => {
    const note = renderLateNote({
      targetAgent: 'calendar',
      classification: abandonedClassification(60),
      maxResultChars: 100,
    });
    expect(note).toContain('before the handle expired');
  });

  it('truncates an oversized result at the configured cap', () => {
    const note = renderLateNote({
      ...base,
      classification: classifyLateResponse(facts()),
      content: 'y'.repeat(500),
      maxResultChars: 20,
    });
    expect(note).toContain('truncated 480 chars');
  });
});

describe('formatDeliveredAt (#1799)', () => {
  const when = new Date('2026-09-14T16:06:43.000Z');

  it('formats in the configured timezone', () => {
    expect(formatDeliveredAt(when, 'America/Toronto')).toBe('2026-09-14T12:06:43.000-04:00');
  });

  it('falls back to UTC with no timezone', () => {
    expect(formatDeliveredAt(when)).toBe('2026-09-14T16:06:43.000Z');
  });

  it('falls back to UTC rather than throwing on a bad timezone', () => {
    // A misconfigured timezone must not be the reason a late result goes unrecorded.
    expect(formatDeliveredAt(when, 'Not/AZone')).toBe('2026-09-14T16:06:43.000Z');
  });
});
