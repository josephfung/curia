import { describe, it, expect } from 'vitest';
import {
  buildCheckpointBudgetNudgeMessage,
  buildExecutionPausedResponse,
  buildResumableCheckpointResumeBlock,
  buildResumableTaskGuidanceBlock,
  boundTaskFromSchedulerContent,
  checkpointNudgeThreshold,
  EXECUTION_PAUSED_PROTOCOL,
  formatPausedProgressMessage,
  isResumableTask,
  parseDelegatePausedData,
  parseExecutionPausedPayload,
  resolveBoundTaskContext,
  shouldSendCheckpointBudgetNudge,
} from './resumable-task.js';
import type { ResumableProgressBlock } from '../db/resumable-progress.js';
import { readResumableBlock } from '../db/resumable-progress.js';
import { computeResumableThroughput } from './resumable-throughput.js';
import type { ResumableCircuitState } from './resumable-circuit-breaker.js';

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

  const warmCircuit: ResumableCircuitState = {
    stallCount: 0,
    iterationCount: 5,
    startedAt: '2026-06-01T00:00:00.000Z',
    totalCostUsd: 0.5,
    lastProgress: { done: 60, cursor: 'page:5' },
  };

  it('falls back to turn fraction on cold start (no throughput context)', () => {
    expect(shouldSendCheckpointBudgetNudge(17, 20, false, null)).toBe(true);
    expect(shouldSendCheckpointBudgetNudge(16, 20, false, null)).toBe(false);
  });

  it('fires throughput-aware nudge before turn fraction when last slice overshot avg', () => {
    const ctx = {
      resumable: { done: 60, total: 1300, lastSliceUnits: 100 },
      circuit: warmCircuit,
    };
    expect(shouldSendCheckpointBudgetNudge(3, 20, false, ctx)).toBe(true);
    expect(shouldSendCheckpointBudgetNudge(2, 20, false, ctx)).toBe(false);
  });

  it('uses turn fraction when throughput estimate unavailable', () => {
    const ctx = {
      resumable: { done: 0, total: 1300, lastSliceUnits: 0 },
      circuit: warmCircuit,
    };
    expect(shouldSendCheckpointBudgetNudge(17, 20, false, ctx)).toBe(true);
    expect(shouldSendCheckpointBudgetNudge(16, 20, false, ctx)).toBe(false);
  });
});

describe('guidance blocks', () => {
  it('includes workspace manifest when provided', () => {
    const block = buildResumableTaskGuidanceBlock({ workspaceManifestPath: '/projects/audit/index.md' });
    expect(block).toContain('/projects/audit/index.md');
  });

  it('notes tail manifest when workspace is active', () => {
    const block = buildResumableTaskGuidanceBlock({
      workspaceManifestPath: '/projects/audit/index.md',
      workspaceManifestInjected: true,
    });
    expect(block).toContain('## Workspace Manifest');
    expect(block).toContain('/projects/audit/index.md');
  });

  it('omits workspace placeholder when no workspace is configured', () => {
    const block = buildResumableTaskGuidanceBlock();
    expect(block).not.toContain('#1209');
    expect(block).not.toContain('document workspace');
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
    expect(text).toContain('no estimate yet');
  });

  it('includes throughput averages and ETA on resume when circuit state exists', () => {
    const block: ResumableProgressBlock = {
      cursor: 'page:5',
      done: 60,
      total: 1300,
      accumulator: [],
      lastSliceUnits: 12,
      next: 'Continue paging',
      checkpointedAt: '2026-06-28T12:00:00.000Z',
    };
    const text = buildResumableCheckpointResumeBlock(block, {
      circuit: {
        stallCount: 0,
        iterationCount: 5,
        startedAt: '2026-06-01T00:00:00.000Z',
        totalCostUsd: 0.5,
        lastProgress: { done: 60, cursor: 'page:5' },
      },
      now: new Date('2026-06-01T01:00:00.000Z'),
    });
    expect(text).toContain('units/slice avg');
    expect(text).toContain('ETA');
    expect(text).toContain('Suggested slice');
  });

  it('includes advisory slice sizing in guidance when throughput is warm', () => {
    const metrics = computeResumableThroughput(
      { done: 60, total: 1300, lastSliceUnits: 12 },
      {
        stallCount: 0,
        iterationCount: 5,
        startedAt: '2026-06-01T00:00:00.000Z',
        totalCostUsd: 0.5,
        lastProgress: { done: 60, cursor: 'page:5' },
      },
      new Date('2026-06-01T01:00:00.000Z'),
    );
    const block = buildResumableTaskGuidanceBlock({ throughputMetrics: metrics });
    expect(block).toContain('Right-sizing (advisory)');
    expect(block).toContain('aim for ~12 this slice');
  });

  it('omits advisory slice sizing on cold start', () => {
    const block = buildResumableTaskGuidanceBlock();
    expect(block).not.toContain('Right-sizing (advisory)');
  });
});

describe('bound task resolution', () => {
  it('reads boundTask from metadata and derives workspace index path', () => {
    const ctx = resolveBoundTaskContext(
      {
        boundTask: {
          taskId: '00000000-0000-0000-0000-000000000099',
          errorBudget: { resumable: true },
          tags: [],
          progress: {},
        },
      },
      JSON.stringify({ task_id: '00000000-0000-0000-0000-000000000099' }),
      'scheduler',
    );
    expect(ctx?.taskId).toBe('00000000-0000-0000-0000-000000000099');
    expect(ctx?.workspaceManifestPath).toBe('/projects/00000000-0000-0000-0000-000000000099/index.md');
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

  it('includes throughput advisory when metrics are warm', () => {
    const metrics = computeResumableThroughput(
      { done: 60, total: 1300, lastSliceUnits: 12 },
      {
        stallCount: 0,
        iterationCount: 5,
        startedAt: '2026-06-01T00:00:00.000Z',
        totalCostUsd: 0.5,
        lastProgress: { done: 60, cursor: 'page:5' },
      },
    );
    const msg = buildCheckpointBudgetNudgeMessage(3, 20, metrics);
    expect(msg).toContain('units/slice');
    expect(msg).toContain('aim for ~12');
  });
});

describe('executor outcome contract (#1174)', () => {
  const checkpoint: ResumableProgressBlock = {
    cursor: 'page-3',
    done: 12,
    total: 1300,
    accumulator: [],
    lastSliceUnits: 12,
    next: 'Continue paging follows',
    checkpointedAt: '2026-06-28T12:00:00.000Z',
  };

  it('round-trips execution_paused protocol JSON', () => {
    const content = buildExecutionPausedResponse({
      taskId: '00000000-0000-0000-0000-000000000099',
      progress: checkpoint,
    });
    const parsed = parseExecutionPausedPayload(content);
    expect(parsed?._curia_protocol).toBe(EXECUTION_PAUSED_PROTOCOL);
    expect(parsed?.task_id).toBe('00000000-0000-0000-0000-000000000099');
    expect(parsed?.done).toBe(12);
    expect(parsed?.total).toBe(1300);
    expect(parsed?.next).toBe('Continue paging follows');
  });

  it('formats paused progress message for coordinator consumption', () => {
    expect(formatPausedProgressMessage(checkpoint)).toBe(
      'Still working — 12 of 1300 complete. Continue paging follows',
    );
  });

  it('parses delegate paused payload', () => {
    const data = parseDelegatePausedData({
      paused: true,
      agent: 'social-media',
      task_id: 'task-1',
      done: 12,
      total: 1300,
      next: 'Continue',
      message: 'Still working — 12 of 1300 complete. Continue',
    });
    expect(data?.paused).toBe(true);
    expect(data?.agent).toBe('social-media');
    expect(data?.task_id).toBe('task-1');
  });

  it('resolves scheduler metadata with checkpoint for budget safety-net (#1174)', () => {
    const ctx = resolveBoundTaskContext(
      {
        boundTask: {
          taskId: 'task-resumable-1',
          errorBudget: { resumable: true },
          progress: {
            resumable: {
              cursor: 'page-2',
              done: 25,
              total: 1300,
              accumulator: [],
              lastSliceUnits: 25,
              next: 'Continue paging',
            },
          },
        },
      },
      JSON.stringify({ task_id: 'task-resumable-1' }),
      'scheduler',
    );
    expect(ctx).not.toBeNull();
    expect(isResumableTask(ctx!)).toBe(true);
    expect(readResumableBlock(ctx!.progress ?? {})).not.toBeNull();
  });
});

describe('parseExecutionPausedPayload negative paths (#1174)', () => {
  const basePayload = {
    _curia_protocol: EXECUTION_PAUSED_PROTOCOL,
    done: 10,
    total: 100,
    cursor: 'page:1',
    last_slice_units: 10,
    next: 'Continue',
  };

  it.each([
    ['invalid JSON', '{not valid json'],
    ['wrong protocol', JSON.stringify({ ...basePayload, _curia_protocol: 'clarification_request' })],
    ['missing total', JSON.stringify({ _curia_protocol: EXECUTION_PAUSED_PROTOCOL, done: 10, cursor: null, last_slice_units: 10, next: 'go' })],
    ['empty next', JSON.stringify({ ...basePayload, next: '' })],
    ['non-object cursor', JSON.stringify({ ...basePayload, cursor: 42 })],
    ['missing last_slice_units', JSON.stringify({ ...basePayload, last_slice_units: undefined })],
  ])('returns null for %s — treated as non-paused', (_label, content) => {
    expect(parseExecutionPausedPayload(content)).toBeNull();
  });

  it('accepts a valid payload without task_id (optional field)', () => {
    const content = JSON.stringify({
      _curia_protocol: EXECUTION_PAUSED_PROTOCOL,
      done: 10,
      total: 100,
      cursor: null,
      last_slice_units: 10,
      next: 'Continue',
    });
    const parsed = parseExecutionPausedPayload(content);
    expect(parsed).not.toBeNull();
    expect(parsed?.task_id).toBeUndefined();
  });
});
