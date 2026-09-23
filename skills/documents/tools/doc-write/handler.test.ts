import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { DocWriteHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { WorkingDocsRepo, WorkingDocRow } from '../../../../src/db/working-docs-repo.js';

const silentLog = pino({ level: 'silent' });

function makeDoc(overrides: Partial<WorkingDocRow> = {}): WorkingDocRow {
  return {
    id: 'doc-1',
    path: '/projects/x/brief.md',
    type: 'project-brief',
    frontmatter: {},
    body: 'seed',
    version: 1,
    sectionVersions: {},
    byteSize: 10,
    taskId: null,
    conversationId: null,
    agentId: null,
    createdAt: '2026-06-28T10:00:00.000Z',
    updatedAt: '2026-06-28T10:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

function makeRepo(overrides: Partial<WorkingDocsRepo> = {}): WorkingDocsRepo {
  const created = makeDoc({ path: '/projects/x/new.md', version: 1, body: 'hello' });
  const appended = makeDoc({ version: 2, body: 'seed\n\nmore' });
  return {
    read: vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(created),
    append: vi.fn().mockResolvedValue({ ok: true, document: appended }),
    update: vi.fn(),
    editSection: vi.fn(),
    projectPrefixHasLiveDocs: vi.fn().mockResolvedValue(false),
    ...overrides,
  } as unknown as WorkingDocsRepo;
}

function makeCtx(input: Record<string, unknown>, repo?: WorkingDocsRepo): ToolContext {
  return {
    input,
    log: silentLog,
    timezone: 'America/Toronto',
    agentId: 'coordinator',
    workingDocs: repo ?? makeRepo(),
  } as unknown as ToolContext;
}

describe('DocWriteHandler', () => {
  it('returns retention_warning when ttl_days is set on a project path', async () => {
    const repo = makeRepo({
      read: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
    });
    const result = await new DocWriteHandler().execute(makeCtx({
      path: '/projects/x/new.md',
      mode: 'create',
      type: 'note',
      body: 'hello',
      frontmatter: { ttl_days: 3 },
    }, repo));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { retention_warning?: string };
      expect(data.retention_warning).toMatch(/scratch/i);
    }
  });

  it('creates a document and appends log.md', async () => {
    const repo = makeRepo({
      read: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
    });
    const result = await new DocWriteHandler().execute(makeCtx({
      path: '/projects/x/new.md',
      mode: 'create',
      type: 'note',
      body: 'hello',
      summary: 'Created note',
    }, repo));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { action?: string };
      expect(data.action).toBe('created');
    }
    expect(repo.create).toHaveBeenCalled();
  });

  it('auto-stamps the project-root task_id when a subtask is bound', async () => {
    const rootId = '00000000-0000-4000-8000-000000000001';
    const childId = '00000000-0000-4000-8000-000000000002';
    const repo = makeRepo({
      read: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
    });
    const ctx = makeCtx({
      path: '/projects/social-media/brief.md',
      mode: 'create',
      type: 'brief',
      body: 'hello',
    }, repo);
    (ctx as { taskMetadata?: Record<string, unknown> }).taskMetadata = {
      boundTask: { taskId: childId },
    };
    (ctx as { taskRepo?: { resolveProjectRootTaskId: (id: string) => Promise<string> } }).taskRepo = {
      resolveProjectRootTaskId: vi.fn(async (id: string) => {
        expect(id).toBe(childId);
        return rootId;
      }),
    };
    const result = await new DocWriteHandler().execute(ctx);
    expect(result.success).toBe(true);
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({
      taskId: rootId,
    }));
  });

  it('claims unowned docs on append without overwriting an existing owner', async () => {
    const rootId = '00000000-0000-4000-8000-000000000001';
    const otherOwner = '00000000-0000-4000-8000-000000000099';
    const unowned = makeDoc({ path: '/projects/shared/brief.md', taskId: null, version: 1 });
    const owned = makeDoc({ path: '/projects/shared/brief.md', taskId: otherOwner, version: 2 });
    const append = vi.fn()
      .mockResolvedValueOnce({ ok: true, document: makeDoc({ path: unowned.path, taskId: rootId, version: 2 }) })
      .mockResolvedValueOnce({ ok: true, document: owned });
    const repo = makeRepo({
      read: vi.fn()
        .mockResolvedValueOnce(unowned)
        .mockResolvedValueOnce(null) // log.md
        .mockResolvedValueOnce(owned)
        .mockResolvedValueOnce(makeDoc({ path: '/projects/shared/log.md', version: 1 })),
      append,
    });

    const ctxUnowned = makeCtx({
      path: '/projects/shared/brief.md',
      mode: 'append',
      content: 'more',
      expected_version: 1,
    }, repo);
    (ctxUnowned as { taskMetadata?: Record<string, unknown> }).taskMetadata = {
      boundTask: { taskId: rootId },
    };
    (ctxUnowned as { taskRepo?: { resolveProjectRootTaskId: (id: string) => Promise<string> } }).taskRepo = {
      resolveProjectRootTaskId: vi.fn(async () => rootId),
    };
    expect((await new DocWriteHandler().execute(ctxUnowned)).success).toBe(true);
    expect(append).toHaveBeenCalledWith(
      '/projects/shared/brief.md',
      expect.objectContaining({ taskId: rootId }),
    );

    const ctxOwned = makeCtx({
      path: '/projects/shared/brief.md',
      mode: 'append',
      content: 'more',
      expected_version: 2,
    }, repo);
    (ctxOwned as { taskMetadata?: Record<string, unknown> }).taskMetadata = {
      boundTask: { taskId: rootId },
    };
    (ctxOwned as { taskRepo?: { resolveProjectRootTaskId: (id: string) => Promise<string> } }).taskRepo = {
      resolveProjectRootTaskId: vi.fn(async () => rootId),
    };
    expect((await new DocWriteHandler().execute(ctxOwned)).success).toBe(true);
    // Handler still passes associatedTaskId; repo COALESCE preserves otherOwner.
    const briefAppends = append.mock.calls.filter(
      (call: unknown[]) => call[0] === '/projects/shared/brief.md',
    );
    expect(briefAppends).toHaveLength(2);
    expect(briefAppends[1]).toEqual([
      '/projects/shared/brief.md',
      expect.objectContaining({ taskId: rootId }),
    ]);
  });

  it('creates directory log.md without a task_id stamp', async () => {
    const rootId = '00000000-0000-4000-8000-000000000001';
    const create = vi.fn()
      .mockResolvedValueOnce(makeDoc({ path: '/projects/x/new.md' }))
      .mockResolvedValueOnce(makeDoc({ path: '/projects/x/log.md', taskId: null }));
    const repo = makeRepo({
      read: vi.fn().mockResolvedValue(null),
      create,
    });
    const ctx = makeCtx({
      path: '/projects/x/new.md',
      mode: 'create',
      type: 'note',
      body: 'hello',
    }, repo);
    (ctx as { taskMetadata?: Record<string, unknown> }).taskMetadata = {
      boundTask: { taskId: rootId },
    };
    (ctx as { taskRepo?: { resolveProjectRootTaskId: (id: string) => Promise<string> } }).taskRepo = {
      resolveProjectRootTaskId: vi.fn(async () => rootId),
    };
    const result = await new DocWriteHandler().execute(ctx);
    expect(result.success).toBe(true);
    const logCreate = create.mock.calls.find(
      (call: unknown[]) => (call[0] as { path?: string }).path === '/projects/x/log.md',
    );
    expect(logCreate).toBeDefined();
    expect((logCreate![0] as { taskId?: string }).taskId).toBeUndefined();
  });

  it('rejects malformed project folder names on create', async () => {
    const result = await new DocWriteHandler().execute(makeCtx({
      path: '/projects/Not A Slug/brief.md',
      mode: 'create',
      type: 'brief',
      body: 'nope',
    }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/kebab-case|slug/i);
  });

  it('rejects inventing a brand-new UUID project folder', async () => {
    const uuid = '3467d2d0-1695-4d90-9789-3319ba5a2c65';
    const repo = makeRepo({
      projectPrefixHasLiveDocs: vi.fn().mockResolvedValue(false),
    });
    const result = await new DocWriteHandler().execute(makeCtx({
      path: `/projects/${uuid}/brief.md`,
      mode: 'create',
      type: 'brief',
      body: 'nope',
    }, repo));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/UUID|kebab-case|slug/i);
  });

  it('rejects unresolved placeholder task_id without throwing', async () => {
    const resolveRoot = vi.fn();
    const ctx = makeCtx({
      path: '/projects/social-media/brief.md',
      mode: 'create',
      type: 'brief',
      body: 'hello',
      task_id: '${principal_contact_id}',
    });
    (ctx as { taskRepo?: { resolveProjectRootTaskId: typeof resolveRoot } }).taskRepo = {
      resolveProjectRootTaskId: resolveRoot,
    };
    const result = await new DocWriteHandler().execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/Unresolved template placeholder/);
    expect(resolveRoot).not.toHaveBeenCalled();
  });

  it('rejects non-UUID task_id without throwing', async () => {
    const resolveRoot = vi.fn();
    const ctx = makeCtx({
      path: '/projects/social-media/brief.md',
      mode: 'create',
      type: 'brief',
      body: 'hello',
      task_id: 'not-a-uuid',
    });
    (ctx as { taskRepo?: { resolveProjectRootTaskId: typeof resolveRoot } }).taskRepo = {
      resolveProjectRootTaskId: resolveRoot,
    };
    const result = await new DocWriteHandler().execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/task UUID/);
    expect(resolveRoot).not.toHaveBeenCalled();
  });

  it('allows create under an existing legacy UUID project directory', async () => {
    const uuid = '3467d2d0-1695-4d90-9789-3319ba5a2c65';
    const repo = makeRepo({
      read: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
      create: vi.fn().mockResolvedValue(makeDoc({ path: `/projects/${uuid}/brief.md` })),
      projectPrefixHasLiveDocs: vi.fn().mockResolvedValue(true),
    });
    const result = await new DocWriteHandler().execute(makeCtx({
      path: `/projects/${uuid}/brief.md`,
      mode: 'create',
      type: 'brief',
      body: 'legacy',
    }, repo));
    expect(result.success).toBe(true);
  });

  it('rejects direct create of reserved index.md', async () => {
    const result = await new DocWriteHandler().execute(makeCtx({
      path: '/projects/x/index.md',
      mode: 'create',
      type: 'index',
    }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/reserved/i);
  });

  it('rejects append to reserved log.md', async () => {
    const result = await new DocWriteHandler().execute(makeCtx({
      path: '/projects/x/log.md',
      mode: 'append',
      content: 'tamper',
      expected_version: 1,
    }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/reserved/i);
  });

  it('succeeds when log append fails after the document write', async () => {
    const repo = makeRepo({
      read: vi.fn().mockImplementation(async (path: string) => {
        if (path.endsWith('/new.md') || path.endsWith('/log.md')) return null;
        return null;
      }),
      create: vi.fn().mockImplementation(async (params: { path: string }) => {
        if (params.path.endsWith('/log.md')) throw new Error('log create failed');
        return makeDoc({ path: '/projects/x/new.md', version: 1, body: 'hello' });
      }),
    });
    const result = await new DocWriteHandler().execute(makeCtx({
      path: '/projects/x/new.md',
      mode: 'create',
      type: 'note',
      body: 'hello',
    }, repo));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { action?: string };
      expect(data.action).toBe('created');
    }
  });

  it('returns conflict data on version mismatch', async () => {
    const repo = makeRepo({
      read: vi.fn().mockResolvedValue(makeDoc()),
      append: vi.fn().mockResolvedValue({
        ok: false,
        conflict: true,
        document: makeDoc({ version: 3 }),
      }),
    });
    const result = await new DocWriteHandler().execute(makeCtx({
      path: '/projects/x/brief.md',
      mode: 'append',
      content: 'more',
      expected_version: 1,
    }, repo));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { conflict?: boolean; version?: number };
      expect(data.conflict).toBe(true);
      expect(data.version).toBe(3);
    }
  });
});
