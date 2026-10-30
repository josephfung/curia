import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { DocWriteHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { WorkingDocsRepo, WorkingDocRow } from '../../../../src/db/working-docs-repo.js';
import { AgentRegistry } from '../../../../src/agents/agent-registry.js';

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
    deleteSection: vi.fn(),
    projectPrefixHasLiveDocs: vi.fn().mockResolvedValue(false),
    existsAtPath: vi.fn().mockResolvedValue(false),
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

  it('does not stamp a task_id on a /meetings/ path, and still stamps project paths', async () => {
    const rootId = '00000000-0000-4000-8000-000000000001';
    const childId = '00000000-0000-4000-8000-000000000002';
    const create = vi.fn().mockResolvedValue(makeDoc());
    const repo = makeRepo({
      read: vi.fn().mockResolvedValue(null),
      create,
    });
    const taskRepo = {
      resolveProjectRootTaskId: vi.fn(async () => rootId),
    };

    const meetings = makeCtx({
      path: '/meetings/agendas/a.md',
      mode: 'create',
      type: 'meeting-agenda',
      body: 'context',
    }, repo);
    (meetings as { taskMetadata?: Record<string, unknown> }).taskMetadata = {
      boundTask: { taskId: childId },
    };
    (meetings as { taskRepo?: typeof taskRepo }).taskRepo = taskRepo;
    expect((await new DocWriteHandler().execute(meetings)).success).toBe(true);
    const meetingsCreate = create.mock.calls.find(
      (call: unknown[]) => (call[0] as { path?: string }).path === '/meetings/agendas/a.md',
    );
    expect(meetingsCreate).toBeDefined();
    expect((meetingsCreate![0] as { taskId?: string | null }).taskId).toBeNull();

    const project = makeCtx({
      path: '/projects/p/a.md',
      mode: 'create',
      type: 'note',
      body: 'hello',
    }, repo);
    (project as { taskMetadata?: Record<string, unknown> }).taskMetadata = {
      boundTask: { taskId: childId },
    };
    (project as { taskRepo?: typeof taskRepo }).taskRepo = taskRepo;
    expect((await new DocWriteHandler().execute(project)).success).toBe(true);
    const projectCreate = create.mock.calls.find(
      (call: unknown[]) => (call[0] as { path?: string }).path === '/projects/p/a.md',
    );
    expect(projectCreate).toBeDefined();
    expect((projectCreate![0] as { taskId?: string | null }).taskId).toBe(rootId);
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

  describe('section-delete (#2339)', () => {
    const PATH = '/projects/x/brief.md';
    const body = '## Board mail\n\n- When: from the board\n\n## Newsletters\n\n- When: Substack\n';

    it('deletes the section, logs it, and reports the new version', async () => {
      const deleteSection = vi.fn().mockResolvedValue({
        ok: true,
        document: makeDoc({ version: 4, body: '## Newsletters\n\n- When: Substack\n' }),
      });
      const repo = makeRepo({ read: vi.fn().mockResolvedValue(makeDoc({ version: 3, body })), deleteSection });
      const result = await new DocWriteHandler().execute(makeCtx({
        path: PATH, mode: 'section-delete', section: ' Board mail ', expected_section_version: 2,
      }, repo));
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { action?: string; document?: { version?: number } };
        expect(data.action).toBe('section-deleted');
        expect(data.document?.version).toBe(4);
      }
      expect(deleteSection).toHaveBeenCalledWith(PATH, { section: 'Board mail', expectedSectionVersion: 2 });
      // The folder's log.md (which the read mock reports as existing) gets an entry.
      expect(repo.append).toHaveBeenCalledWith('/projects/x/log.md', expect.objectContaining({
        content: expect.stringContaining('section-delete'),
      }));
    });

    it('fails on a missing section, without logging, so no removal is confirmed', async () => {
      const deleteSection = vi.fn().mockResolvedValue({ ok: false, missingSection: true, document: makeDoc({ body }) });
      const repo = makeRepo({ read: vi.fn().mockResolvedValue(makeDoc({ body })), deleteSection });
      const result = await new DocWriteHandler().execute(makeCtx({
        path: PATH, mode: 'section-delete', section: 'Coffee',
      }, repo));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/No section 'Coffee'.*nothing was deleted/);
      expect(repo.create).not.toHaveBeenCalled();
      expect(repo.append).not.toHaveBeenCalled();
    });

    it('returns conflict data on a section version mismatch', async () => {
      const deleteSection = vi.fn().mockResolvedValue({
        ok: false, conflict: true, document: makeDoc({ version: 5, sectionVersions: { 'Board mail': 3 } }),
      });
      const repo = makeRepo({ read: vi.fn().mockResolvedValue(makeDoc({ body })), deleteSection });
      const result = await new DocWriteHandler().execute(makeCtx({
        path: PATH, mode: 'section-delete', section: 'Board mail', expected_section_version: 1,
      }, repo));
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { conflict?: boolean; section_versions?: Record<string, number> };
        expect(data.conflict).toBe(true);
        expect(data.section_versions).toEqual({ 'Board mail': 3 });
      }
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('requires a section and an existing document', async () => {
      const noSection = await new DocWriteHandler().execute(makeCtx({ path: PATH, mode: 'section-delete' }, makeRepo()));
      expect(noSection.success).toBe(false);
      if (!noSection.success) expect(noSection.error).toMatch(/requires section/);

      const repo = makeRepo({ read: vi.fn().mockResolvedValue(null) });
      const noDoc = await new DocWriteHandler().execute(makeCtx({ path: PATH, mode: 'section-delete', section: 'A' }, repo));
      expect(noDoc.success).toBe(false);
      expect(repo.deleteSection).not.toHaveBeenCalled();
    });
  });

  describe('/shared/ write guard (#2338)', () => {
    const SHARED = '/shared/inbox/rules.md';

    function roster(): AgentRegistry {
      const registry = new AgentRegistry();
      registry.register('ceo-inbox', { role: 'specialist', description: 'inbox', pinnedDocPaths: [SHARED] });
      registry.register('editor', { role: 'specialist', description: 'editor', pinnedDocPaths: [SHARED] });
      registry.register('coordinator', { role: 'coordinator', description: 'coord', pinnedDocPaths: [] });
      return registry;
    }

    function sharedCtx(agentId: string | undefined, input: Record<string, unknown>, repo: WorkingDocsRepo): ToolContext {
      const ctx = makeCtx(input, repo) as unknown as Record<string, unknown>;
      ctx.agentId = agentId;
      ctx.agentRegistry = roster();
      return ctx as unknown as ToolContext;
    }

    it('rejects an agent that does not declare the path, without touching the repo', async () => {
      const repo = makeRepo();
      const result = await new DocWriteHandler().execute(sharedCtx('coordinator', {
        path: SHARED, mode: 'create', type: 'agent-settings', body: 'x',
      }, repo));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/pinned_context/);
      expect(repo.read).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('rejects an undeclared path under /shared/ even for an agent that declares another', async () => {
      const repo = makeRepo();
      const result = await new DocWriteHandler().execute(sharedCtx('ceo-inbox', {
        path: '/shared/calendar/rules.md', mode: 'create', type: 'agent-settings', body: 'x',
      }, repo));
      expect(result.success).toBe(false);
    });

    it('rejects a path that normalizes into a declared /shared/ document only when undeclared', async () => {
      const repo = makeRepo();
      const result = await new DocWriteHandler().execute(sharedCtx('coordinator', {
        path: '/projects/../shared/inbox/rules.md', mode: 'create', type: 'agent-settings', body: 'x',
      }, repo));
      expect(result.success).toBe(false);
    });

    it('guards section-delete like every other mode (#2339)', async () => {
      const repo = makeRepo();
      const result = await new DocWriteHandler().execute(sharedCtx('coordinator', {
        path: SHARED, mode: 'section-delete', section: 'Board mail',
      }, repo));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/pinned_context/);
      expect(repo.deleteSection).not.toHaveBeenCalled();
    });

    it('rejects a call with no agent or no roster', async () => {
      const noAgent = await new DocWriteHandler().execute(sharedCtx(undefined, {
        path: SHARED, mode: 'create', type: 'agent-settings', body: 'x',
      }, makeRepo()));
      expect(noAgent.success).toBe(false);

      const ctx = makeCtx({ path: SHARED, mode: 'create', type: 'agent-settings', body: 'x' }, makeRepo());
      (ctx as { agentId?: string }).agentId = 'ceo-inbox';
      expect((await new DocWriteHandler().execute(ctx)).success).toBe(false);
    });

    it('lets every declaring agent write, and never stamps a task_id', async () => {
      const childId = '00000000-0000-4000-8000-000000000002';
      for (const agentId of ['ceo-inbox', 'editor']) {
        const create = vi.fn().mockResolvedValue(makeDoc({ path: SHARED }));
        const repo = makeRepo({ read: vi.fn().mockResolvedValue(null), create });
        const ctx = sharedCtx(agentId, { path: SHARED, mode: 'create', type: 'agent-settings', body: '## A' }, repo);
        (ctx as { taskMetadata?: Record<string, unknown> }).taskMetadata = { boundTask: { taskId: childId } };
        (ctx as { taskRepo?: unknown }).taskRepo = { resolveProjectRootTaskId: vi.fn(async () => childId) };
        const result = await new DocWriteHandler().execute(ctx);
        expect(result.success, agentId).toBe(true);
        expect((create.mock.calls[0]![0] as { taskId?: string | null }).taskId).toBeNull();
      }
    });

    it('refuses to create over an archived /shared/ document, even for a declaring agent', async () => {
      const create = vi.fn();
      const repo = makeRepo({
        read: vi.fn().mockResolvedValue(null),
        existsAtPath: vi.fn().mockResolvedValue(true),
        create,
      });
      const result = await new DocWriteHandler().execute(sharedCtx('ceo-inbox', {
        path: SHARED, mode: 'create', type: 'agent-settings', body: 'x',
      }, repo));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/archived by the principal.*restore it in the console/);
      expect(create).not.toHaveBeenCalled();
    });

    it('allows a principal-approved re-execution, which carries no agent', async () => {
      const create = vi.fn().mockResolvedValue(makeDoc({ path: SHARED }));
      const repo = makeRepo({ read: vi.fn().mockResolvedValue(null), create });
      const ctx = sharedCtx(undefined, { path: SHARED, mode: 'create', type: 'agent-settings', body: 'x' }, repo);
      (ctx as { humanApproved?: boolean }).humanApproved = true;
      expect((await new DocWriteHandler().execute(ctx)).success).toBe(true);
      expect(create).toHaveBeenCalled();
    });
  });
});
