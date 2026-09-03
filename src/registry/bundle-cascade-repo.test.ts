import { describe, it, expect, vi } from 'vitest';
import { BundleCascadeRepo } from './bundle-cascade-repo.js';
import type { DbPool } from '../db/connection.js';

// Minimal fake pool: records every query text so we can assert transaction shape.
function fakePool(failOn?: string) {
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql.trim().split('\n')[0]!.trim());
      if (failOn && sql.includes(failOn)) throw new Error('boom');
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) } as unknown as DbPool;
  return { pool, client, queries };
}

const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

describe('BundleCascadeRepo.enableBundle', () => {
  it('writes the bundle and every member tool inside one transaction', async () => {
    const { pool, client, queries } = fakePool();
    const repo = new BundleCascadeRepo(pool, logger as never);

    await repo.enableBundle('ceo-inbox', ['ceo-inbox-list', 'ceo-inbox-read'], 'web-app');

    expect(queries[0]).toBe('BEGIN');
    expect(queries[queries.length - 1]).toBe('COMMIT');
    // one skill_registry upsert + one tool_registry upsert per member
    expect(queries.filter(q => q.includes('skill_registry'))).toHaveLength(1);
    expect(queries.filter(q => q.includes('tool_registry'))).toHaveLength(2);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rolls back and rethrows when a member write fails', async () => {
    const { pool, client, queries } = fakePool('tool_registry');
    const repo = new BundleCascadeRepo(pool, logger as never);

    await expect(
      repo.enableBundle('ceo-inbox', ['ceo-inbox-list'], 'web-app'),
    ).rejects.toThrow('boom');

    expect(queries).toContain('ROLLBACK');
    expect(queries).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe('BundleCascadeRepo.disableBundle', () => {
  it('disables the bundle and every member tool in one transaction', async () => {
    const { pool, queries } = fakePool();
    const repo = new BundleCascadeRepo(pool, logger as never);

    await repo.disableBundle('ceo-inbox', ['ceo-inbox-list'], 'web-app');

    expect(queries[0]).toBe('BEGIN');
    expect(queries[queries.length - 1]).toBe('COMMIT');
  });
});
