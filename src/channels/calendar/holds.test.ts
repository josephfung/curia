// src/channels/calendar/holds.test.ts
//
// Unit tests for the shared hold helper functions in holds.ts.
// All functions are pure (no I/O), so tests are synchronous and require no mocks.

import { describe, it, expect } from 'vitest';
import {
  CURIA_HOLD_KEY,
  buildHoldMetadata,
  extractConversationRef,
  findHoldsByConversationRef,
  findHoldsForConversationRelease,
  findMatchingHolds,
  holdSharesConversationRef,
  isHoldEvent,
  matchHoldCandidate,
  normalizeContactDomain,
  normalizeSchedulingSubject,
  recoverConversationRef,
  eventsOverlap,
  isHoldStale,
} from './holds.js';

// ---------------------------------------------------------------------------
// buildHoldMetadata
// ---------------------------------------------------------------------------

describe('buildHoldMetadata', () => {
  it('produces required keys: curia-hold and created-at', () => {
    const meta = buildHoldMetadata({ createdAtIso: '2026-06-24T12:00:00.000Z' });
    expect(meta[CURIA_HOLD_KEY]).toBe('true');
    expect(meta['created-at']).toBe('2026-06-24T12:00:00.000Z');
  });

  it('omits source-ref when sourceRef is not provided', () => {
    const meta = buildHoldMetadata({ createdAtIso: '2026-06-24T12:00:00.000Z' });
    expect('source-ref' in meta).toBe(false);
  });

  it('includes source-ref when sourceRef is provided', () => {
    const meta = buildHoldMetadata({
      createdAtIso: '2026-06-24T12:00:00.000Z',
      sourceRef: 'msg-abc123',
    });
    expect(meta['source-ref']).toBe('msg-abc123');
  });

  it('contains exactly the right keys when sourceRef is omitted', () => {
    const meta = buildHoldMetadata({ createdAtIso: '2026-06-24T12:00:00.000Z' });
    expect(Object.keys(meta).sort()).toEqual(['created-at', 'curia-hold']);
  });

  it('contains exactly the right keys when sourceRef is provided', () => {
    const meta = buildHoldMetadata({
      createdAtIso: '2026-06-24T12:00:00.000Z',
      sourceRef: 'task-7',
    });
    expect(Object.keys(meta).sort()).toEqual(['created-at', 'curia-hold', 'source-ref']);
  });

  it('includes optional subject and contact-domain metadata for later invite matching', () => {
    const meta = buildHoldMetadata({
      createdAtIso: '2026-06-24T12:00:00.000Z',
      subject: 'Quick sync - Project Delta',
      contactDomain: 'assistant@example.test',
      contactId: 'contact-1',
      threadRef: 'thread-1',
    });

    expect(meta.subject).toBe('Quick sync - Project Delta');
    expect(meta['contact-domain']).toBe('example.test');
    expect(meta['contact-id']).toBe('contact-1');
    expect(meta['thread-ref']).toBe('thread-1');
  });
});

describe('hold conversation ref release', () => {
  const conversationRef = { sourceRef: 'msg-negotiation', threadRef: 'thread-negotiation' };

  const holdA1 = {
    id: 'hold-a1',
    title: 'HOLD (TBC): Project Alpha sync',
    startTime: 1_780_000_000,
    endTime: 1_780_003_600,
    metadata: buildHoldMetadata({
      createdAtIso: '2026-06-24T12:00:00.000Z',
      subject: 'Project Alpha sync',
      contactDomain: 'example.test',
      ...conversationRef,
    }),
  };

  const holdA2 = {
    ...holdA1,
    id: 'hold-a2',
    startTime: 1_780_086_400,
    endTime: 1_780_090_000,
  };

  const holdB1 = {
    id: 'hold-b1',
    title: 'HOLD (TBC): Project Beta sync',
    startTime: 1_780_000_000,
    endTime: 1_780_003_600,
    metadata: buildHoldMetadata({
      createdAtIso: '2026-06-24T12:00:00.000Z',
      subject: 'Project Beta sync',
      contactDomain: 'example.test',
      sourceRef: 'msg-other',
      threadRef: 'thread-other',
    }),
  };

  it('releases all holds sharing a recovered source-ref', () => {
    const released = findHoldsForConversationRelease([holdA1, holdA2, holdB1], {
      sourceRef: conversationRef.sourceRef,
    });
    expect(released.map((hold) => hold.id)).toEqual(['hold-a1', 'hold-a2']);
  });

  it('releases on an exact thread-ref match alone', () => {
    const released = findHoldsForConversationRelease([holdA1, holdA2], {
      threadRef: conversationRef.threadRef,
    });
    expect(released.map((hold) => hold.id)).toEqual(['hold-a1', 'hold-a2']);
  });

  it('anchors by accepted-slot time overlap when invite refs miss', () => {
    const released = findHoldsForConversationRelease([holdA1, holdA2, holdB1], {
      subject: 'Project Alpha sync',
      contactDomain: 'example.test',
      threadRef: 'invite-thread-only',
      startTime: holdA1.startTime,
      endTime: holdA1.endTime,
    });
    expect(released.map((hold) => hold.id)).toEqual(['hold-a1', 'hold-a2']);
  });

  it('does not release same-domain holds from a different conversation', () => {
    const released = findHoldsForConversationRelease([holdA1, holdA2, holdB1], {
      subject: 'Project Alpha sync',
      contactDomain: 'example.test',
      startTime: holdA1.startTime,
      endTime: holdA1.endTime,
    });
    expect(released.map((hold) => hold.id)).toEqual(['hold-a1', 'hold-a2']);
    expect(released.some((hold) => hold.id === 'hold-b1')).toBe(false);
  });

  it('releases nothing when no ref can be recovered and no time anchor matches', () => {
    const orphanHold = {
      ...holdA1,
      id: 'hold-orphan',
      metadata: buildHoldMetadata({
        createdAtIso: '2026-06-24T12:00:00.000Z',
        subject: 'Project Alpha sync',
        contactDomain: 'example.test',
      }),
    };
    const released = findHoldsForConversationRelease([orphanHold], {
      subject: 'Project Alpha sync',
      contactDomain: 'example.test',
    });
    expect(released).toEqual([]);
  });

  it('extracts conversation refs from hold metadata', () => {
    expect(extractConversationRef(holdA1)).toEqual(conversationRef);
    expect(holdSharesConversationRef(holdA2, conversationRef)).toBe(true);
    expect(recoverConversationRef([holdA1], { threadRef: conversationRef.threadRef })).toEqual({
      threadRef: conversationRef.threadRef,
    });
    expect(findHoldsByConversationRef([holdA1, holdB1], conversationRef).map((h) => h.id)).toEqual(['hold-a1']);
  });
});

describe('hold invite matching helpers', () => {
  const hold = {
    id: 'hold-1',
    title: 'HOLD (TBC): Project Delta sync',
    startTime: 1_780_000_000,
    endTime: 1_780_003_600,
    metadata: buildHoldMetadata({
      createdAtIso: '2026-06-24T12:00:00.000Z',
      subject: 'Project Delta sync',
      contactDomain: 'example.test',
      sourceRef: 'msg-1',
    }),
  };

  it('normalizes reply prefixes and HOLD titles out of scheduling subjects', () => {
    expect(normalizeSchedulingSubject('Re: HOLD (TBC): Quick sync - Project Delta')).toBe('quick sync project delta');
  });

  it('normalizes email addresses to organization domains', () => {
    expect(normalizeContactDomain('assistant@example.test')).toBe('example.test');
  });

  it('scores fuzzy candidate matches for legacy scoring callers', () => {
    const match = matchHoldCandidate(hold, {
      subject: 'Quick Project Delta sync',
      contactDomain: 'scheduler@example.test',
      startTime: 1_780_000_000,
      endTime: 1_780_003_600,
    });

    expect(match).not.toBeNull();
    expect(match!.score).toBeGreaterThanOrEqual(75);
    expect(match!.reasons).toContain('contact-domain');
  });

  it('does not match a same-subject hold from a different organization domain', () => {
    const match = matchHoldCandidate(hold, {
      subject: 'Project Delta sync',
      contactDomain: 'other.example',
      startTime: 1_780_000_000,
      endTime: 1_780_003_600,
    });

    expect(match).toBeNull();
  });

  it('returns all associated holds sorted by score', () => {
    const secondHold = {
      ...hold,
      id: 'hold-2',
      startTime: 1_780_086_400,
      endTime: 1_780_090_000,
      metadata: buildHoldMetadata({
        createdAtIso: '2026-06-24T12:00:00.000Z',
        subject: 'Project Delta sync',
        contactDomain: 'example.test',
      }),
    };

    const matches = findMatchingHolds([secondHold, hold], {
      subject: 'Project Delta sync',
      contactDomain: 'example.test',
    });

    expect(matches.map((match) => match.hold.id)).toEqual(['hold-2', 'hold-1']);
  });
});

// ---------------------------------------------------------------------------
// isHoldEvent
// ---------------------------------------------------------------------------

describe('isHoldEvent', () => {
  it('returns true when metadata has curia-hold === "true"', () => {
    const event = { metadata: { [CURIA_HOLD_KEY]: 'true' } };
    expect(isHoldEvent(event)).toBe(true);
  });

  it('returns false when curia-hold is missing', () => {
    const event = { metadata: { 'other-key': 'val' } };
    expect(isHoldEvent(event)).toBe(false);
  });

  it('returns false when curia-hold is "false" (not the magic string)', () => {
    const event = { metadata: { [CURIA_HOLD_KEY]: 'false' } };
    expect(isHoldEvent(event)).toBe(false);
  });

  it('returns false when metadata is null', () => {
    const event = { metadata: null };
    expect(isHoldEvent(event)).toBe(false);
  });

  it('returns false when metadata is undefined', () => {
    const event = {};
    expect(isHoldEvent(event)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// eventsOverlap -- boundary cases are critical
// ---------------------------------------------------------------------------

describe('eventsOverlap', () => {
  // Slot A: expressed as Unix seconds for clarity
  const A_START = 1000;
  const A_END = 2000;

  it('returns true when B is entirely inside A', () => {
    expect(eventsOverlap(A_START, A_END, 1200, 1800)).toBe(true);
  });

  it('returns true when A is entirely inside B', () => {
    expect(eventsOverlap(A_START, A_END, 500, 2500)).toBe(true);
  });

  it('returns true when B partially overlaps the start of A', () => {
    // B ends inside A
    expect(eventsOverlap(A_START, A_END, 800, 1200)).toBe(true);
  });

  it('returns true when B partially overlaps the end of A', () => {
    // B starts inside A
    expect(eventsOverlap(A_START, A_END, 1800, 2200)).toBe(true);
  });

  it('returns false when B ends exactly at A start (touching edges do NOT overlap)', () => {
    // B.end === A.start -- the open interval check aStart < bEnd is not satisfied
    expect(eventsOverlap(A_START, A_END, 500, A_START)).toBe(false);
  });

  it('returns false when B starts exactly at A end (touching edges do NOT overlap)', () => {
    // B.start === A.end -- the open interval check aEnd > bStart is not satisfied
    expect(eventsOverlap(A_START, A_END, A_END, 2500)).toBe(false);
  });

  it('returns false when B is entirely before A', () => {
    expect(eventsOverlap(A_START, A_END, 0, 500)).toBe(false);
  });

  it('returns false when B is entirely after A', () => {
    expect(eventsOverlap(A_START, A_END, 2500, 3000)).toBe(false);
  });

  it('returns true when A and B share the exact same window', () => {
    expect(eventsOverlap(A_START, A_END, A_START, A_END)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isHoldStale
// ---------------------------------------------------------------------------

describe('isHoldStale', () => {
  const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 h

  // Reference "now" expressed as Unix seconds
  const NOW_UNIX = 1_000_000;
  const NOW_ISO = new Date(NOW_UNIX * 1000).toISOString();

  // An event that ends 1 hour in the future
  const FUTURE_END = NOW_UNIX + 3600;
  // An event that ended 1 hour in the past
  const PAST_END = NOW_UNIX - 3600;

  it('returns false when slot is in the future and hold is fresh', () => {
    const event = {
      endTime: FUTURE_END,
      metadata: { 'created-at': NOW_ISO },
    };
    expect(isHoldStale(event, NOW_UNIX, MAX_AGE_MS)).toBe(false);
  });

  it('returns true when slot has already ended (slot end in the past)', () => {
    const event = {
      endTime: PAST_END,
      metadata: { 'created-at': NOW_ISO },
    };
    expect(isHoldStale(event, NOW_UNIX, MAX_AGE_MS)).toBe(true);
  });

  it('returns true when slot is in the future but hold was created longer ago than maxAgeMs', () => {
    // created-at is 25 hours in the past
    const oldCreatedAt = new Date((NOW_UNIX - 25 * 3600) * 1000).toISOString();
    const event = {
      endTime: FUTURE_END,
      metadata: { 'created-at': oldCreatedAt },
    };
    expect(isHoldStale(event, NOW_UNIX, MAX_AGE_MS)).toBe(true);
  });

  it('returns false when created-at is exactly at maxAgeMs boundary (not stale yet)', () => {
    // created-at is exactly 24 h ago -- the age equals maxAgeMs, which is NOT stale
    // (stale is strictly > maxAgeMs)
    const boundaryCreatedAt = new Date((NOW_UNIX * 1000) - MAX_AGE_MS).toISOString();
    const event = {
      endTime: FUTURE_END,
      metadata: { 'created-at': boundaryCreatedAt },
    };
    expect(isHoldStale(event, NOW_UNIX, MAX_AGE_MS)).toBe(false);
  });

  it('returns true when created-at is missing from metadata (cannot determine age -- treat as stale)', () => {
    // No created-at means we cannot verify freshness -- conservative: treat stale
    const event = {
      endTime: FUTURE_END,
      metadata: {},
    };
    expect(isHoldStale(event, NOW_UNIX, MAX_AGE_MS)).toBe(true);
  });

  it('returns true when metadata is null (cannot verify freshness)', () => {
    const event = {
      endTime: FUTURE_END,
      metadata: null,
    };
    expect(isHoldStale(event, NOW_UNIX, MAX_AGE_MS)).toBe(true);
  });
});
