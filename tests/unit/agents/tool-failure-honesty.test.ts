import { describe, it, expect } from 'vitest';
import {
  looksLikeUnacknowledgedSuccess,
  buildUnresolvedFailureReply,
  humanizeToolFailureMessage,
} from '../../../src/agents/tool-failure-honesty.js';

describe('tool-failure-honesty (#1546)', () => {
  // Prod forensic: conversation email:19f843bdadc2eb85 @ 2026-07-21T13:11Z —
  // resolve-learning-digest failed on truncated task id; coordinator replied
  // "Got it — I've noted the dismissal."
  it('flags the prod success-confirmation phrasing', () => {
    expect(
      looksLikeUnacknowledgedSuccess("Got it — I've noted the dismissal."),
    ).toBe(true);
  });

  it('does not flag a reply that already acknowledges failure', () => {
    expect(
      looksLikeUnacknowledgedSuccess(
        "I couldn't dismiss that — no actionable confirm item for task 3502c6bb. Want me to try with the full id?",
      ),
    ).toBe(false);
  });

  it('does not flag a neutral informational reply', () => {
    expect(
      looksLikeUnacknowledgedSuccess('Here is what I found on your calendar today.'),
    ).toBe(false);
  });

  it('builds a humanized honest reply from skill_error payloads', () => {
    const reply = buildUnresolvedFailureReply([
      {
        toolName: 'resolve-learning-digest',
        message: '<skill_error>No actionable confirm item for task 3502c6bb</skill_error>',
      },
    ]);
    expect(reply).toContain("wasn't able to complete");
    expect(reply).toContain('No actionable confirm item for task 3502c6bb');
    expect(reply).not.toContain('<skill_error>');
  });

  it('humanizeToolFailureMessage strips wrappers', () => {
    expect(humanizeToolFailureMessage('<skill_error>boom</skill_error>')).toBe('boom');
  });
});
