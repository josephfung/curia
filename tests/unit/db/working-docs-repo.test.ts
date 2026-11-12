// working-docs-repo.test.ts — unit tests with a mock pool (no Postgres required).

import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { WorkingDocsRepo } from '../../../src/db/working-docs-repo.js';
import { createSilentLogger } from '../../../src/logger.js';

const BASE_ROW = {
  id: 'doc-1',
  path: '/projects/x/brief.md',
  type: 'project-brief',
  frontmatter: { title: 'Brief' },
  body: '## Progress\n\nOld.\n',
  version: 1,
  section_versions: { Progress: 0 },
  byte_size: 100,
  task_id: null,
  conversation_id: null,
  agent_id: null,
  created_at: '2026-06-26T00:00:00.000Z',
  updated_at: '2026-06-26T00:00:00.000Z',
  archived_at: null,
};

function makeClient(handlers: {
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
}): PoolClient {
  return {
    query: vi.fn(handlers.query),
    release: vi.fn(),
  } as unknown as PoolClient;
}

function makePool(client: PoolClient, poolQuery?: Pool['query']): { pool: Pool; connect: ReturnType<typeof vi.fn> } {
  const connect = vi.fn(async () => client);
  const pool = { connect, query: poolQuery ?? client.query } as unknown as Pool;
  return { pool, connect };
}

describe('WorkingDocsRepo (unit)', () => {
  it('create inserts a row and indexes links in a transaction', async () => {
    const queries: string[] = [];
    const client = makeClient({
      query: async (sql: string) => {
        queries.push(sql);
        if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 } as unknown as QueryResult;
        if (sql.startsWith('INSERT INTO working_documents')) {
          return { rows: [{ ...BASE_ROW, body: 'See [[findings]].' }], rowCount: 1 } as QueryResult;
        }
        if (sql.startsWith('DELETE FROM working_document_links')) {
          return { rows: [], rowCount: 0 } as unknown as QueryResult;
        }
        if (sql.startsWith('INSERT INTO working_document_links')) {
          return { rows: [], rowCount: 1 } as unknown as QueryResult;
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
    });
    const { pool } = makePool(client);
    const repo = new WorkingDocsRepo(pool, createSilentLogger());
    const doc = await repo.create({
      path: '/projects/x/brief.md',
      type: 'project-brief',
      body: 'See [[findings]].',
    });
    expect(doc.path).toBe('/projects/x/brief.md');
    expect(queries.some(q => q.startsWith('INSERT INTO working_document_links'))).toBe(true);
  });

  it('update returns conflict when expected_version mismatches pre-check', async () => {
    const client = makeClient({
      query: async (sql: string) => {
        if (sql.includes('FROM working_documents') && sql.includes('SELECT')) {
          return { rows: [{ ...BASE_ROW, version: 2 }], rowCount: 1 } as QueryResult;
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
    });
    const { pool } = makePool(client);
    const repo = new WorkingDocsRepo(pool, createSilentLogger());
    const result = await repo.update('/projects/x/brief.md', {
      body: 'new',
      expectedVersion: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toBe(true);
      expect(result.document.version).toBe(2);
    }
  });

  it('editSection checks per-section version, not document version', async () => {
    let sectionVersionChecked = false;
    const client = makeClient({
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('FOR UPDATE')) {
          return {
            rows: [{
              ...BASE_ROW,
              version: 5,
              section_versions: { Progress: 1, Decisions: 0 },
            }],
            rowCount: 1,
          } as QueryResult;
        }
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rows: [], rowCount: 0 } as unknown as QueryResult;
        }
        if (sql.includes('COALESCE((section_versions->>$5)::int, 0) = $6')) {
          sectionVersionChecked = true;
          expect(params?.[4]).toBe('Decisions');
          expect(params?.[5]).toBe(0);
          return {
            rows: [{
              ...BASE_ROW,
              version: 6,
              body: '## Progress\n\nOld.\n\n## Decisions\n\nNew.\n',
              section_versions: { Progress: 1, Decisions: 1 },
            }],
            rowCount: 1,
          } as QueryResult;
        }
        if (sql.startsWith('DELETE FROM working_document_links')) {
          return { rows: [], rowCount: 0 } as unknown as QueryResult;
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
    });
    const { pool } = makePool(client);
    const repo = new WorkingDocsRepo(pool, createSilentLogger());
    const result = await repo.editSection('/projects/x/brief.md', {
      section: 'Decisions',
      content: 'New.',
      expectedSectionVersion: 0,
    });
    expect(sectionVersionChecked).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('purgeExpiredScratch archives only expired /scratch/<conversation-id>/… rows', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = makeClient({
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 } as unknown as QueryResult;
        if (sql.includes('WITH archived AS')) {
          return { rows: [{ archived_count: '1' }], rowCount: 1 } as QueryResult;
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
    });
    const { pool } = makePool(client);
    const repo = new WorkingDocsRepo(pool, createSilentLogger());
    const archived = await repo.purgeExpiredScratch(7);
    expect(archived).toBe(1);
    expect(queries.some(q => q.sql.includes("path ~ '^/scratch/[^/]+/'"))).toBe(true);
    expect(queries.some(q => q.sql.includes('UPDATE working_documents'))).toBe(true);
    expect(queries.some(q => q.sql.includes('DELETE FROM working_documents'))).toBe(false);
  });

  it('purgeExpiredScratch is a no-op when nothing is expired', async () => {
    const client = makeClient({
      query: async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 } as unknown as QueryResult;
        if (sql.includes('WITH archived AS')) return { rows: [{ archived_count: '0' }], rowCount: 0 } as unknown as QueryResult;
        throw new Error(`unexpected sql: ${sql}`);
      },
    });
    const { pool } = makePool(client);
    const repo = new WorkingDocsRepo(pool, createSilentLogger());
    await expect(repo.purgeExpiredScratch(7)).resolves.toBe(0);
  });

  it('archiveProjectWorkspaceDocs archives by task_id and project path prefix', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = makeClient({
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 } as unknown as QueryResult;
        if (sql.includes('WITH archived AS')) {
          return { rows: [{ archived_count: '3' }], rowCount: 1 } as QueryResult;
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
    });
    const { pool } = makePool(client);
    const repo = new WorkingDocsRepo(pool, createSilentLogger());
    const rootTaskId = '00000000-0000-4000-8000-000000000001';
    const archived = await repo.archiveProjectWorkspaceDocs(rootTaskId);
    expect(archived).toBe(3);
    const archiveQuery = queries.find(q => q.sql.includes('WITH archived AS'));
    expect(archiveQuery?.params?.[0]).toBe(rootTaskId);
    expect(archiveQuery?.params?.[1]).toBe('/projects/00000000-0000-4000-8000-000000000001/%');
    expect(archiveQuery?.sql).toContain('task_id = $1::uuid');
    // Path arm is UUID-folder only — must not use a shared slug prefix (#1819).
    expect(archiveQuery?.params?.[1]).not.toContain('social-media');
  });

  it('listLiveByTaskId queries by task_id', async () => {
    const taskId = '00000000-0000-4000-8000-000000000002';
    const client = makeClient({
      query: async () => ({ rows: [], rowCount: 0 } as unknown as QueryResult),
    });
    const poolQuery = vi.fn(async (_sql: string, params?: unknown[]) => {
      expect(params?.[0]).toBe(taskId);
      return {
        rows: [{ ...BASE_ROW, task_id: taskId, path: '/projects/shared/a.md' }],
        rowCount: 1,
      } as QueryResult;
    });
    const pool = {
      connect: vi.fn(async () => client),
      query: poolQuery,
    } as unknown as Pool;
    const repo = new WorkingDocsRepo(pool, createSilentLogger());
    const rows = await repo.listLiveByTaskId(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path).toBe('/projects/shared/a.md');
    expect(poolQuery).toHaveBeenCalled();
    expect(String(poolQuery.mock.calls[0]![0])).toContain('task_id = $1::uuid');
  });
});

describe('WorkingDocsRepo section versions across write paths (#2398)', () => {
  const RULES_BODY = '## Board mail\n\n- Status: active\n\n## Newsletters\n\n- Status: paused\n';

  function updateClient(captured: Array<{ sql: string; params?: unknown[] }>) {
    return makeClient({
      query: async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rows: [], rowCount: 0 } as unknown as QueryResult;
        }
        if (sql.includes('FROM working_documents') && sql.includes('SELECT')) {
          return {
            rows: [{ ...BASE_ROW, body: RULES_BODY, section_versions: { 'Board mail': 1, Newsletters: 3 } }],
            rowCount: 1,
          } as QueryResult;
        }
        if (sql.startsWith('UPDATE working_documents')) {
          return {
            rows: [{ ...BASE_ROW, body: params?.[3], version: 2, section_versions: JSON.parse(params?.[12] as string) }],
            rowCount: 1,
          } as QueryResult;
        }
        if (sql.startsWith('DELETE FROM working_document_links') || sql.startsWith('INSERT INTO working_document_links')) {
          return { rows: [], rowCount: 0 } as unknown as QueryResult;
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
    });
  }

  it('update bumps changed and new sections, drops removed ones, and keeps untouched counters', async () => {
    const captured: Array<{ sql: string; params?: unknown[] }> = [];
    const { pool } = makePool(updateClient(captured));
    const repo = new WorkingDocsRepo(pool, createSilentLogger());
    // Board mail changes, Newsletters is removed, Decisions is new.
    const result = await repo.update('/projects/x/brief.md', {
      body: '## Board mail\n\n- Status: paused\n\n## Decisions\n\n- Ship it\n',
      expectedVersion: 1,
    });
    expect(result.ok).toBe(true);
    const updateQuery = captured.find(q => q.sql.startsWith('UPDATE working_documents'))!;
    expect(updateQuery.sql).toContain('section_versions = $13::jsonb');
    expect(JSON.parse(updateQuery.params?.[12] as string)).toEqual({ 'Board mail': 2, Decisions: 1 });
  });

  it('update with an unchanged body leaves every counter alone', async () => {
    const captured: Array<{ sql: string; params?: unknown[] }> = [];
    const { pool } = makePool(updateClient(captured));
    const repo = new WorkingDocsRepo(pool, createSilentLogger());
    const result = await repo.update('/projects/x/brief.md', { body: RULES_BODY, expectedVersion: 1 });
    expect(result.ok).toBe(true);
    const updateQuery = captured.find(q => q.sql.startsWith('UPDATE working_documents'))!;
    expect(JSON.parse(updateQuery.params?.[12] as string)).toEqual({ 'Board mail': 1, Newsletters: 3 });
  });

  function editClient(
    captured: Array<{ sql: string; params?: unknown[] }>,
    sectionVersions: Record<string, number>,
  ) {
    return makeClient({
      query: async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rows: [], rowCount: 0 } as unknown as QueryResult;
        }
        if (sql.includes('FOR UPDATE')) {
          return {
            rows: [{ ...BASE_ROW, body: RULES_BODY, version: 5, section_versions: sectionVersions }],
            rowCount: 1,
          } as QueryResult;
        }
        if (sql.startsWith('UPDATE working_documents')) {
          return {
            rows: [{ ...BASE_ROW, version: 6, section_versions: JSON.parse(params?.[2] as string) }],
            rowCount: 1,
          } as QueryResult;
        }
        if (sql.startsWith('DELETE FROM working_document_links') || sql.startsWith('INSERT INTO working_document_links')) {
          return { rows: [], rowCount: 0 } as unknown as QueryResult;
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
    });
  }

  it('editSection conflicts on a stale expected version held under another spelling', async () => {
    const captured: Array<{ sql: string; params?: unknown[] }> = [];
    const { pool } = makePool(editClient(captured, { 'Board mail': 1 }));
    const repo = new WorkingDocsRepo(pool, createSilentLogger());
    const result = await repo.editSection('/projects/x/brief.md', {
      section: 'board mail',
      content: '- Status: paused',
      expectedSectionVersion: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toBe(true);
    expect(captured.some(q => q.sql.startsWith('UPDATE working_documents'))).toBe(false);
  });

  it('editSection merges case-variant keys onto the spelling holding the highest counter', async () => {
    const captured: Array<{ sql: string; params?: unknown[] }> = [];
    const { pool } = makePool(editClient(captured, { 'Board mail': 1, 'board MAIL': 3, Newsletters: 1 }));
    const repo = new WorkingDocsRepo(pool, createSilentLogger());
    const result = await repo.editSection('/projects/x/brief.md', {
      section: 'BOARD MAIL',
      content: '- Status: paused',
      expectedSectionVersion: 3,
    });
    expect(result.ok).toBe(true);
    const updateQuery = captured.find(q => q.sql.startsWith('UPDATE working_documents'))!;
    expect(JSON.parse(updateQuery.params?.[2] as string)).toEqual({ 'board MAIL': 4, Newsletters: 1 });
    // The SQL guard pins the surviving key and the merged counter value.
    expect(updateQuery.params?.[4]).toBe('board MAIL');
    expect(updateQuery.params?.[5]).toBe(3);
  });

  it('deleteSection reads the counter across case-variant keys, not just exact ones', async () => {
    const captured: Array<{ sql: string; params?: unknown[] }> = [];
    const { pool } = makePool(editClient(captured, { 'Board mail': 1, 'board MAIL': 3, Newsletters: 1 }));
    const repo = new WorkingDocsRepo(pool, createSilentLogger());
    // The counter the caller holds is the merged one (3, as editSection reports
    // it), stored under a spelling that is neither the caller's nor the body
    // heading's. An exact-key lookup would read the heading's key (1) and
    // refuse the delete as stale.
    const result = await repo.deleteSection('/projects/x/brief.md', {
      section: 'BOARD MAIL',
      expectedSectionVersion: 3,
    });
    expect(result.ok).toBe(true);
    const updateQuery = captured.find(q => q.sql.startsWith('UPDATE working_documents'))!;
    // Every spelling of the deleted heading's counter goes; other sections stay.
    expect(JSON.parse(updateQuery.params?.[2] as string)).toEqual({ Newsletters: 1 });
  });
});
