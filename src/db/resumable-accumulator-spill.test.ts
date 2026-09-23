import { describe, it, expect, vi } from 'vitest';
import {
  ACCUMULATOR_DOC_TYPE,
  accumulatorDocLeaf,
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
import { collisionShortId } from '../agents/document-placement.js';
import type { WorkingDocsRepo, WorkingDocRow } from './working-docs-repo.js';

const ROOT_A = '00000000-0000-4000-8000-00000000000a';
const ROOT_B = '00000000-0000-4000-8000-00000000000b';

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
    path: accumulatorDocPath('/projects/social-media/', ROOT_A),
    type: ACCUMULATOR_DOC_TYPE,
    frontmatter: {},
    body: '',
    version: 1,
    sectionVersions: {},
    byteSize: 0,
    taskId: ROOT_A,
    conversationId: null,
    agentId: 'agent',
    createdAt: '2026-06-28T12:00:00.000Z',
    updatedAt: '2026-06-28T12:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

describe('accumulatorDocPath / formatAccumulatorDocumentBody', () => {
  it('builds a task-scoped spill path under a workspace prefix', () => {
    expect(accumulatorDocLeaf(ROOT_A)).toBe(`accumulator-${collisionShortId(ROOT_A)}.md`);
    expect(accumulatorDocPath('/projects/social-media/', ROOT_A))
      .toBe(`/projects/social-media/accumulator-${collisionShortId(ROOT_A)}.md`);
    const body = formatAccumulatorDocumentBody(['a', 'b']);
    expect(body).toContain('# Accumulator');
    expect(body).toContain('```json');
    expect(body).toContain('"a"');
  });
});

describe('spillInlineAccumulator', () => {
  it('creates a new workspace document on first spill', async () => {
    const path = accumulatorDocPath('/projects/social-media/', ROOT_A);
    const create = vi.fn(async () => makeDoc({ path }));
    const read = vi.fn(async () => null);
    const repo = { create, read, update: vi.fn() } as unknown as WorkingDocsRepo;

    const pointer = await spillInlineAccumulator(repo, {
      rootTaskId: ROOT_A,
      workspacePrefix: '/projects/social-media/',
      agentId: 'social-media',
      inlineValue: ['did:plc:abc'],
    });

    expect(pointer).toEqual(documentAccumulatorPointer(path));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      path,
      type: ACCUMULATOR_DOC_TYPE,
      taskId: ROOT_A,
    }));
  });

  it('updates an existing spill document owned by the same root', async () => {
    const path = accumulatorDocPath('/projects/social-media/', ROOT_A);
    const existing = makeDoc({ path, version: 2, body: 'old', taskId: ROOT_A });
    const read = vi.fn(async () => existing);
    const update = vi.fn(async () => ({ ok: true as const, document: makeDoc({ path, version: 3 }) }));
    const repo = { create: vi.fn(), read, update } as unknown as WorkingDocsRepo;

    const pointer = await spillInlineAccumulator(repo, {
      rootTaskId: ROOT_A,
      workspacePrefix: '/projects/social-media/',
      inlineValue: ['did:plc:def'],
    });

    expect(pointer.path).toBe(path);
    expect(update).toHaveBeenCalledOnce();
    const [, updateParams] = update.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(updateParams).toMatchObject({ expectedVersion: 2 });
    expect(updateParams).not.toHaveProperty('taskId');
  });

  it('uses distinct leaves for two roots in one shared folder', async () => {
    const read = vi.fn(async () => null);
    const create = vi.fn(async (params: { path: string; taskId?: string }) =>
      makeDoc({ path: params.path, taskId: params.taskId ?? null }),
    );
    const repo = { create, read, update: vi.fn() } as unknown as WorkingDocsRepo;

    const a = await spillInlineAccumulator(repo, {
      rootTaskId: ROOT_A,
      workspacePrefix: '/projects/social-media/',
      inlineValue: ['a'],
    });
    const b = await spillInlineAccumulator(repo, {
      rootTaskId: ROOT_B,
      workspacePrefix: '/projects/social-media/',
      inlineValue: ['b'],
    });

    expect(a.path).toBe(accumulatorDocPath('/projects/social-media/', ROOT_A));
    expect(b.path).toBe(accumulatorDocPath('/projects/social-media/', ROOT_B));
    expect(a.path).not.toBe(b.path);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('throws when an existing leaf belongs to another task', async () => {
    const pathB = accumulatorDocPath('/projects/social-media/', ROOT_B);
    const existing = makeDoc({ path: pathB, taskId: ROOT_A });
    const read = vi.fn(async () => existing);
    const repo = { create: vi.fn(), read, update: vi.fn() } as unknown as WorkingDocsRepo;

    await expect(spillInlineAccumulator(repo, {
      rootTaskId: ROOT_B,
      workspacePrefix: '/projects/social-media/',
      inlineValue: ['b-data'],
    })).rejects.toThrow(/belongs to task/);
    expect(repo.update).not.toHaveBeenCalled();
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
      projectPrefixHasLiveDocs: vi.fn(async () => false),
    } as unknown as WorkingDocsRepo;
    const result = await prepareResumableBlockWithSpill(BASE_INPUT, {
      workingDocsRepo: repo,
      rootTaskId: ROOT_A,
      taskId: 'child',
      title: 'Social media',
    });
    expect(result.ok).toBe(true);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('spills under a suggested slug with a task-scoped leaf', async () => {
    const big = 'x'.repeat(RESUMABLE_INLINE_ACCUMULATOR_MAX_BYTES);
    const expectedPath = accumulatorDocPath('/projects/social-media/', ROOT_A);
    const create = vi.fn(async () => makeDoc({ path: expectedPath }));
    const repo = {
      create,
      read: vi.fn(async () => null),
      update: vi.fn(),
      listLiveByTaskId: vi.fn(async () => []),
      listByPrefix: vi.fn(async () => []),
      projectPrefixHasLiveDocs: vi.fn(async () => false),
    } as unknown as WorkingDocsRepo;

    const result = await prepareResumableBlockWithSpill(
      { ...BASE_INPUT, accumulator: [big] },
      {
        workingDocsRepo: repo,
        rootTaskId: ROOT_A,
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
      path: expectedPath,
      taskId: ROOT_A,
    }));
  });

  it('keeps two roots\' accumulators distinct in one shared prefix', async () => {
    const big = 'x'.repeat(RESUMABLE_INLINE_ACCUMULATOR_MAX_BYTES);
    const created: string[] = [];
    const repo = {
      create: vi.fn(async (params: { path: string; taskId?: string }) => {
        created.push(params.path);
        return makeDoc({ path: params.path, taskId: params.taskId ?? null });
      }),
      read: vi.fn(async () => null),
      update: vi.fn(),
      listLiveByTaskId: vi.fn(async (id: string) => [
        makeDoc({
          path: '/projects/social-media/brief.md',
          taskId: id,
          updatedAt: '2026-06-29T12:00:00.000Z',
        }),
      ]),
      listByPrefix: vi.fn(async () => []),
      projectPrefixHasLiveDocs: vi.fn(async () => true),
    } as unknown as WorkingDocsRepo;

    const a = await prepareResumableBlockWithSpill(
      { ...BASE_INPUT, accumulator: [big] },
      { workingDocsRepo: repo, rootTaskId: ROOT_A, taskId: 'child-a', title: 'Social media' },
    );
    const b = await prepareResumableBlockWithSpill(
      { ...BASE_INPUT, accumulator: [big] },
      { workingDocsRepo: repo, rootTaskId: ROOT_B, taskId: 'child-b', title: 'Social media' },
    );

    expect(a.ok && b.ok).toBe(true);
    expect(created).toEqual([
      accumulatorDocPath('/projects/social-media/', ROOT_A),
      accumulatorDocPath('/projects/social-media/', ROOT_B),
    ]);
    expect(created[0]).not.toBe(created[1]);
  });
});
