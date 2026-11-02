import { describe, expect, it } from 'vitest';
import { findCompletionClaim } from '../../../../src/channels/voice/completion-claim.js';

describe('findCompletionClaim (#2428)', () => {
  it('catches the reply from the first kick-off call', () => {
    expect(findCompletionClaim("Done, boss. I'll let you know if she replies.")).toBe('done');
  });

  it.each([
    "I've sent her a note.",
    'Okay. All set for Friday.',
    "That's booked for 9.",
    'I just emailed him.',
    'Sure thing. Sent.',
  ])('catches %s', (text) => {
    expect(findCompletionClaim(text)).not.toBeNull();
  });

  it.each([
    'Are you done with the calendar?',
    'I can send her a note after the call.',
    'Want me to send it, or leave it as a draft?',
    'Nothing is booked on Friday yet.',
    'Once that is done I will email you.',
  ])('ignores %s', (text) => {
    expect(findCompletionClaim(text)).toBeNull();
  });
});
