import { describe, it, expect } from 'vitest';
import { parseSchedulerRunJobId } from '../../../src/scheduler/conversation-id.js';

describe('parseSchedulerRunJobId (#1828)', () => {
  it('extracts the job UUID from a 3-part run conversation id', () => {
    expect(
      parseSchedulerRunJobId('scheduler:123e4567-e89b-12d3-a456-426614174000:run-001'),
    ).toBe('123e4567-e89b-12d3-a456-426614174000');
  });

  it('rejects 2-part notification IDs', () => {
    expect(parseSchedulerRunJobId('scheduler:123e4567-e89b-12d3-a456-426614174000')).toBeUndefined();
    expect(parseSchedulerRunJobId('scheduler:job-abc')).toBeUndefined();
  });

  it('rejects non-UUID middle segments', () => {
    expect(parseSchedulerRunJobId('scheduler:not-a-uuid:run-001')).toBeUndefined();
  });

  // #1879 loosened this from RFC v1-v5 to shape-only. These pin that choice: the
  // failure mode of rejecting here is silent (callers read undefined as "not a
  // scheduled run", never as "malformed id"), so a future tightening must break
  // a test rather than quietly stop deriving job ids.
  it('accepts a v7 middle segment (shape-only since #1879)', () => {
    expect(
      parseSchedulerRunJobId('scheduler:018f3a9c-7b21-7d4e-8f6a-1c2b3d4e5f60:run-001'),
    ).toBe('018f3a9c-7b21-7d4e-8f6a-1c2b3d4e5f60');
  });

  it('accepts a nil middle segment (shape-only since #1879)', () => {
    expect(
      parseSchedulerRunJobId('scheduler:00000000-0000-0000-0000-000000000000:run-001'),
    ).toBe('00000000-0000-0000-0000-000000000000');
  });

  // The prefix is a literal, so it must stay case-sensitive. Composing UUID_PATTERN
  // with an 'i' flag (the obvious way to keep uppercase hex working) would case-fold
  // `scheduler:` too and quietly widen what parses; UUID_PATTERN spells both hex
  // cases itself so the flag is not needed. These two pin both halves of that.
  it('keeps the scheduler: prefix case-sensitive', () => {
    expect(
      parseSchedulerRunJobId('SCHEDULER:123e4567-e89b-12d3-a456-426614174000:run-001'),
    ).toBeUndefined();
    expect(
      parseSchedulerRunJobId('Scheduler:123e4567-e89b-12d3-a456-426614174000:run-001'),
    ).toBeUndefined();
  });

  it('still accepts uppercase hex in the job UUID', () => {
    expect(
      parseSchedulerRunJobId('scheduler:123E4567-E89B-12D3-A456-426614174000:run-001'),
    ).toBe('123E4567-E89B-12D3-A456-426614174000');
  });

  it('still requires a full UUID shape in the middle', () => {
    expect(parseSchedulerRunJobId('scheduler:123e4567-e89b-12d3-a456:run-001')).toBeUndefined();
    expect(parseSchedulerRunJobId('scheduler:123e4567e89b12d3a456426614174000:run-001')).toBeUndefined();
  });

  it('rejects non-scheduler and empty ids', () => {
    expect(parseSchedulerRunJobId('signal:+15551234567')).toBeUndefined();
    expect(parseSchedulerRunJobId('delegate-abc')).toBeUndefined();
    expect(parseSchedulerRunJobId(undefined)).toBeUndefined();
    expect(parseSchedulerRunJobId('')).toBeUndefined();
  });
});
