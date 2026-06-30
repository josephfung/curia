// task-repo.seed.test.ts — initial-progress seeding for createTask (#1267).

import { describe, it, expect } from 'vitest';
import { buildInitialTaskProgress } from './task-repo.js';
import type { TaskEscalation } from '../agents/task-escalation.js';

const NOW = new Date('2026-06-01T00:00:00.000Z');

const ESCALATION: TaskEscalation = {
  failureMode: 'stalled',
  reason: 'stall_limit',
  source: 'resumable_leaf',
  headline: 'Stalled at 25 of 1300.',
  progress: { done: 25, total: 1300 },
  suggestedActions: ['Cancel or change approach.'],
};

describe('buildInitialTaskProgress (#1267)', () => {
  it('defaults to an empty notes array (matches the legacy {"notes":[]} seed)', () => {
    expect(buildInitialTaskProgress({})).toEqual({ notes: [] });
  });

  it('seeds an initial progress note so the digest (last_progress_note) has content', () => {
    const progress = buildInitialTaskProgress({ progressNote: 'breach summary', now: NOW });
    expect(progress).toEqual({
      notes: [{ at: NOW.toISOString(), note: 'breach summary' }],
    });
  });

  it('attaches the structured escalation block under progress.escalation', () => {
    const progress = buildInitialTaskProgress({ progressNote: 'breach summary', escalation: ESCALATION, now: NOW });
    expect(progress.escalation).toEqual(ESCALATION);
    expect((progress.notes as unknown[]).length).toBe(1);
  });
});
