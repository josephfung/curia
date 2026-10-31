import { describe, expect, it } from 'vitest';
import { findInternalJargon } from '../../../../src/channels/voice/spoken-jargon.js';

describe('findInternalJargon (#2379)', () => {
  it('finds the internal names heard on the 2026-10-30 call', () => {
    expect(findInternalJargon("I'll have the calendar specialist send her a short note.")).toEqual(['specialist']);
    expect(findInternalJargon("I'll hand that off to the coordinator with an async offramp.")).toEqual([
      'coordinator',
      'async',
      'offramp',
    ]);
    expect(findInternalJargon('Delegating to the Specialists now, via the off-ramp.')).toEqual([
      'delegating',
      'specialists',
      'off-ramp',
    ]);
  });

  it('passes ordinary spoken replies', () => {
    expect(findInternalJargon('Let me check your calendar, one moment.')).toEqual([]);
    expect(findInternalJargon("I'll work on that after we hang up and email it to you.")).toEqual([]);
  });

  // The runtime only warns, so a rare ordinary use costs a log line, not the reply.
  it('also matches the ordinary sense of a term', () => {
    expect(findInternalJargon('Your delegation to Ottawa lands at noon.')).toEqual(['delegation']);
  });
});
