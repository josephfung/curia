import { describe, it, expect } from 'vitest';
import {
  buildCheckpointBudgetNudgeMessage,
  buildResumableCheckpointResumeBlock,
  buildResumableTaskGuidanceBlock,
  boundTaskFromSchedulerContent,
  checkpointNudgeThreshold,
  isResumableTask,
  resolveBoundTaskContext,
  shouldSendCheckpointBudgetNudge,
} from './resumable-task.js';
import type { ResumableProgressBlock } from '../db/resumable-progress.js';

describe('isResumableTask', () => {
  it('returns true when error_budget.resumable is set', () => {
    expect(isResumableTask({ errorBudget: { resumable: true }, progress: {} })).toBe(true);
  });

  it('returns true when tags include resumable', () => {
    expect(isResumableTask({ tags: ['resumable'], progress: {} })).toBe(true);
  });

  it('returns true when progress already has a resumable block', () => {
    expect(isResumableTask({
      progress: {
        resumable: {
          cursor: 'page-2',
          done: 10,
          total: 100,
          accumulator: [],
          lastSliceUnits: 10,
          next: 'Continue paging',
        },
      },
    })).toBe(true);
  });

  it('returns false for ordinary tasks', () => {
    expect(isResumableTask({ errorBudget: {}, tags: [], progress: { notes: [] } })).toBe(false);
  });
});

describe('checkpoint budget nudge', () => {
  it('uses ~15% of maxTurns as the threshold', () => {
    expect(checkpointNudgeThreshold(20)).toBe(3);
    expect(checkpointNudgeThreshold(25)).toBe(3);
  });

  it('fires once when remaining turns drop to the threshold', () => {
    expect(shouldSendCheckpointBudgetNudge(17, 20, false)).toBe(true);
    expect(shouldSendCheckpointBudgetNudge(16, 20, false)).toBe(false);
    expect(shouldSendCheckpointBudgetNudge(17, 20, true)).toBe(false);
  });
});

describe('guidance blocks', () => {
  it('includes workspace manifest when provided', () => {
    const block = buildResumableTaskGuidanceBlock({ workspaceManifestPath: '/projects/audit/index.md' });
    expect(block).toContain('/projects/audit/index.md');
  });

  it('notes #1209 follow-up when workspace manifest is absent', () => {
    const block = buildResumableTaskGuidanceBlock();
    expect(block).toContain('#1209');
  });

  it('formats checkpoint resume block', () => {
    const block: ResumableProgressBlock = {
      cursor: 'cursor-abc',
      done: 12,
      total: 1300,
      accumulator: ['flagged-1'],
      lastSliceUnits: 12,
      next: 'Page 2 of follows',
      checkpointedAt: '2026-06-28T12:00:00.000Z',
    };
    const text = buildResumableCheckpointResumeBlock(block);
    expect(text).toContain('12 / 1300');
    expect(text).toContain('Page 2 of follows');
  });
});

describe('bound task resolution', () => {
  it('reads boundTask from metadata', () => {
    const ctx = resolveBoundTaskContext(
      {
        boundTask: {
          taskId: '00000000-0000-0000-0000-000000000099',
          errorBudget: { resumable: true },
          tags: [],
          progress: {},
        },
      },
      '{}',
      'scheduler',
    );
    expect(ctx?.taskId).toBe('00000000-0000-0000-0000-000000000099');
    expect(isResumableTask(ctx!)).toBe(true);
  });

  it('falls back to scheduler content JSON', () => {
    const content = JSON.stringify({
      task_id: '00000000-0000-0000-0000-000000000088',
      progress: { resumable: { cursor: null, done: 0, total: 1, accumulator: [], lastSliceUnits: 0, next: 'start' } },
    });
    const ctx = boundTaskFromSchedulerContent(content);
    expect(ctx?.taskId).toBe('00000000-0000-0000-0000-000000000088');
  });
});

describe('buildCheckpointBudgetNudgeMessage', () => {
  it('names remaining turns explicitly', () => {
    const msg = buildCheckpointBudgetNudgeMessage(3, 20);
    expect(msg).toContain('3 of 20');
    expect(msg).toContain('checkpoint');
  });
});
