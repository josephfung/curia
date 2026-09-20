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

  it('rejects non-scheduler and empty ids', () => {
    expect(parseSchedulerRunJobId('signal:+15551234567')).toBeUndefined();
    expect(parseSchedulerRunJobId('delegate-abc')).toBeUndefined();
    expect(parseSchedulerRunJobId(undefined)).toBeUndefined();
    expect(parseSchedulerRunJobId('')).toBeUndefined();
  });
});
