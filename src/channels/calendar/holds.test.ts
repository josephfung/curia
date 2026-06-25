// src/channels/calendar/holds.test.ts
//
// Unit tests for the shared hold helper functions in holds.ts.
// All functions are pure (no I/O), so tests are synchronous and require no mocks.

import { describe, it, expect } from 'vitest';
import {
  CURIA_HOLD_KEY,
  buildHoldMetadata,
  isHoldEvent,
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
