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
