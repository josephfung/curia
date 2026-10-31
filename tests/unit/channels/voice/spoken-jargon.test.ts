import { describe, expect, it } from 'vitest';
import { findInternalJargon } from '../../../../src/channels/voice/spoken-jargon.js';

describe('findInternalJargon (#2379)', () => {
  it('finds the internal names heard on the 2026-10-30 call', () => {
    expect(findInternalJargon("I'll have the calendar specialist send her a short note.")).toEqual(['calendar specialist']);
    expect(findInternalJargon("I'll hand that off to the coordinator with an async offramp.")).toEqual([
      'coordinator',
      'offramp',
    ]);
    expect(findInternalJargon("I'll ask the calendar specialist, one moment.")).toEqual(['calendar specialist']);
    expect(findInternalJargon('Sending it via the off-ramp to a sub-agent.')).toEqual(['off-ramp', 'sub-agent']);
  });

  // A warning that fires on ordinary speech would be ignored (review on #2389).
  it.each([
    'Let me check your calendar, one moment.',
    "I'll work on that after we hang up and email it to you.",
    "I'll delegate that to Maya.",
    'You should see a specialist about that knee.',
    'Your delegation to Ottawa lands at noon.',
    "We'll sort it out async over email.",
  ])('passes ordinary speech: %s', (text) => {
    expect(findInternalJargon(text)).toEqual([]);
  });
});
