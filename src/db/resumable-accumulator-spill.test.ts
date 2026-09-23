import { describe, it, expect, vi } from 'vitest';
import {
  ACCUMULATOR_DOC_TYPE,
  accumulatorDocPath,
  formatAccumulatorDocumentBody,
  prepareResumableBlockWithSpill,
  spillInlineAccumulator,
} from './resumable-accumulator-spill.js';
import {
  RESUMABLE_BLOCK_MAX_BYTES,
  RESUMABLE_INLINE_ACCUMULATOR_MAX_BYTES,
  documentAccumulatorPointer,
  isDocumentPointer,
  resumableBlockBytes,
} from './resumable-progress.js';
import type { WorkingDocsRepo, WorkingDocRow } from './working-docs-repo.js';

const BASE_INPUT = {
  cursor: 'page:3',
  done: 300,
  total: 1300,
  accumulator: ['did:plc:abc'],
  lastSliceUnits: 25,
  next: 'Review page 4',
};

function makeDoc(overrides: Partial<WorkingDocRow> = {}): WorkingDocRow {
  return {
    id: 'doc-id',
    path: '/projects/social-media/accumulator.md',
    type: ACCUMULATOR_DOC_TYPE,
    frontmatter: {},
    body: '',
    version: 1,
    sectionVersions: {},
    byteSize: 0,
    taskId: 'root',
    conversationId: null,
    agentId: 'agent',
    createdAt: '2026-06-28T12:00:00.000Z',
    updatedAt: '2026-06-28T12:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

describe('accumulatorDocPath / formatAccumulatorDocumentBody', () => {
  it('builds the spill path under a workspace prefix and JSON body', () => {
    expect(accumulatorDocPath('/projects/social-media/')).toBe('/projects/social-media/accumulator.md');
    expect(accumulatorDocPath('/projects/social-media')).toBe('/projects/social-media/accumulator.md');
    const body = formatAccumulatorDocumentBody(['a', 'b']);
    expect(body).toContain('# Accumulator');
    expect(body).toContain('```json');
    expect(body).toContain('"a"');
  });

  it('uses a longer fence when serialized JSON contains backticks', () => {
    const body = formatAccumulatorDocumentBody(['```']);
    expect(body).toContain('````json');
    expect(body).toContain('````\n');
    expect(body).not.toMatch(/\n```\n\[/);
  });
});

describe('spillInlineAccumulator', () => {
  it('creates a new workspace document on first spill', async () => {
    const create = vi.fn(async () => makeDoc());
    const read = vi.fn(async () => null);
    const repo = { create, read, update: vi.fn() } as unknown as WorkingDocsRepo;

    const pointer = await spillInlineAccumulator(repo, {
      rootTaskId: 'root',
      workspacePrefix: '/projects/social-media/',
      agentId: 'social-media',
      inlineValue: ['did:plc:abc'],
    });

    expect(pointer).toEqual(documentAccumulatorPointer('/projects/social-media/accumulator.md'));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      path: '/projects/social-media/accumulator.md',
      type: ACCUMULATOR_DOC_TYPE,
      taskId: 'root',
      agentId: 'social-media',
    }));
  });

  it('updates an existing spill document', async () => {
    const existing = makeDoc({ version: 2, body: 'old' });
    const read = vi.fn(async () => existing);
    const update = vi.fn(async () => ({ ok: true as const, document: makeDoc({ version: 3 }) }));
    const repo = { create: vi.fn(), read, update } as unknown as WorkingDocsRepo;

    const pointer = await spillInlineAccumulator(repo, {
      rootTaskId: 'root',
      workspacePrefix: '/projects/social-media/',
      inlineValue: ['did:plc:def'],
    });

    expect(pointer.path).toBe('/projects/social-media/accumulator.md');
    expect(update).toHaveBeenCalledWith('/projects/social-media/accumulator.md', expect.objectContaining({
      expectedVersion: 2,
      taskId: 'root',
    }));
  });

  it('retries as update when concurrent writers race on first create', async () => {
    const existing = makeDoc({ version: 1 });
    const read = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existing);
    const create = vi.fn(async () => { throw new Error('duplicate key'); });
    const update = vi.fn(async () => ({ ok: true as const, document: makeDoc({ version: 2 }) }));
    const repo = { create, read, update } as unknown as WorkingDocsRepo;

    const pointer = await spillInlineAccumulator(repo, {
      rootTaskId: 'root',
      workspacePrefix: '/projects/social-media/',
      inlineValue: ['did:plc:abc'],
    });

    expect(pointer.path).toBe('/projects/social-media/accumulator.md');
    expect(create).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
  });
});

describe('prepareResumableBlockWithSpill', () => {
  it('passes through valid inline blocks unchanged', async () => {
    const repo = {
      create: vi.fn(),
      read: vi.fn(),
      update: vi.fn(),
      listLiveByTaskId: vi.fn(async () => []),
      listByPrefix: vi.fn(async () => []),
    } as unknown as WorkingDocsRepo;
    const result = await prepareResumableBlockWithSpill(BASE_INPUT, {
      workingDocsRepo: repo,
      rootTaskId: '00000000-0000-4000-8000-000000000001',
      taskId: 'child',
      title: 'Social media',
    });
    expect(result.ok).toBe(true);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('spills inline overflow under a suggested slug when no workspace exists', async () => {
    const big = 'x'.repeat(RESUMABLE_INLINE_ACCUMULATOR_MAX_BYTES);
    const create = vi.fn(async () => makeDoc({ path: '/projects/social-media/accumulator.md' }));
    const repo = {
      create,
      read: vi.fn(async () => null),
      update: vi.fn(),
      listLiveByTaskId: vi.fn(async () => []),
      listByPrefix: vi.fn(async () => []),
    } as unknown as WorkingDocsRepo;

    const result = await prepareResumableBlockWithSpill(
      { ...BASE_INPUT, accumulator: [big] },
      {
        workingDocsRepo: repo,
        rootTaskId: '00000000-0000-4000-8000-000000000001',
        taskId: 'child',
        agentId: 'agent',
        title: 'Social media',
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isDocumentPointer(result.block.accumulator)).toBe(true);
    expect(resumableBlockBytes(result.block)).toBeLessThanOrEqual(RESUMABLE_BLOCK_MAX_BYTES);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      path: '/projects/social-media/accumulator.md',
      taskId: '00000000-0000-4000-8000-000000000001',
    }));
  });

  it('reuses an owned workspace prefix when present', async () => {
    const big = 'x'.repeat(RESUMABLE_INLINE_ACCUMULATOR_MAX_BYTES);
    const root = '00000000-0000-4000-8000-000000000001';
    const create = vi.fn(async () => makeDoc({ path: '/projects/audit/accumulator.md' }));
    const repo = {
      create,
      read: vi.fn(async () => null),
      update: vi.fn(),
      listLiveByTaskId: vi.fn(async () => [
        makeDoc({
          path: '/projects/audit/brief.md',
          taskId: root,
          updatedAt: '2026-06-29T12:00:00.000Z',
        }),
      ]),
      listByPrefix: vi.fn(async () => []),
    } as unknown as WorkingDocsRepo;

    const result = await prepareResumableBlockWithSpill(
      { ...BASE_INPUT, accumulator: [big] },
      { workingDocsRepo: repo, rootTaskId: root, taskId: 'child', title: 'Other title' },
    );

    expect(result.ok).toBe(true);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      path: '/projects/audit/accumulator.md',
    }));
  });
});
