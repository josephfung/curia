// working-docs-repo.test.ts — unit tests with a mock pool (no Postgres required).

import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { WorkingDocsRepo } from './working-docs-repo.js';
import { createSilentLogger } from '../logger.js';

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
});
