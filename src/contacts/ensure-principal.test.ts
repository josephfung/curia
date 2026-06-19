// src/contacts/ensure-principal.test.ts
//
// Unit tests for ensurePrincipalContact.
//
// Strategy: mock the pool and client so the tests run without Docker/Postgres.
// We assert the SQL INSERT does NOT reference `status` or `trust_level` and that
// it sets tier='principal', kind='principal', system_role='principal'.

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

// ---------------------------------------------------------------------------
// Minimal mock infrastructure
// ---------------------------------------------------------------------------

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

interface MockClient {
  query: MockedFunction<QueryFn>;
  release: MockedFunction<() => void>;
}

function makeClient(): MockClient {
  return {
    query: vi.fn(),
    release: vi.fn(),
  };
}

function makePool(
  opts: {
    /** Rows returned by the first SELECT (existing principal lookup) */
    existingRows?: unknown[];
    /** Client returned by pool.connect() */
    client?: MockClient;
  } = {},
) {
  const client = opts.client ?? makeClient();
  const pool = {
    query: vi.fn<QueryFn>().mockResolvedValue({ rows: opts.existingRows ?? [] }),
    connect: vi.fn().mockResolvedValue(client),
  };
  return { pool, client };
}

// ---------------------------------------------------------------------------
// Import the module under test AFTER setting up the mock for ceo-bootstrap
// ---------------------------------------------------------------------------

// We need to mock ceo-bootstrap's exported helpers because they reach the DB.
vi.mock('./ceo-bootstrap.js', () => ({
  insertKgPersonNode: vi.fn().mockResolvedValue('kg-node-123'),
  createAndLinkKgNode: vi.fn().mockResolvedValue('kg-node-existing'),
  repairPrincipalMetadata: vi.fn().mockResolvedValue(undefined),
}));

import { ensurePrincipalContact } from './ensure-principal.js';
import * as ceoBootstrap from './ceo-bootstrap.js';
import type { Logger } from '../logger.js';

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn().mockReturnThis(),
  fatal: vi.fn(),
  silent: vi.fn(),
  level: 'info',
} as unknown as Logger;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ensurePrincipalContact: INSERT column list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('INSERT does NOT reference status or trust_level', async () => {
    // Arrange: no existing principal → will execute the INSERT path
    const client = makeClient();
    // BEGIN, INSERT, COMMIT — all succeed
    client.query.mockResolvedValue({ rows: [] });

    const { pool } = makePool({ existingRows: [], client });
    // pool.query for the existence SELECT returns no rows (handled by makePool default)

    // Act
    await ensurePrincipalContact({ displayName: 'Test CEO' }, pool as never, mockLogger);

    // Collect every SQL string the client executed
    const sqlCalls = client.query.mock.calls.map((c) => (c[0] as string).toLowerCase());

    // Assert: no legacy columns in any query
    for (const sql of sqlCalls) {
      expect(sql, `SQL should not reference "status": ${sql}`).not.toContain('status');
      expect(sql, `SQL should not reference "trust_level": ${sql}`).not.toContain('trust_level');
    }
  });

  it('INSERT sets tier=principal, kind=principal, system_role=principal', async () => {
    const client = makeClient();
    client.query.mockResolvedValue({ rows: [] });

    const { pool } = makePool({ existingRows: [], client });

    await ensurePrincipalContact({ displayName: 'Test CEO' }, pool as never, mockLogger);

    // Find the INSERT statement specifically
    const insertCall = client.query.mock.calls.find(
      (c) => (c[0] as string).toLowerCase().includes('insert into contacts'),
    );
    expect(insertCall, 'Should have executed an INSERT INTO contacts').toBeDefined();

    const insertSql = (insertCall![0] as string).toLowerCase();
    expect(insertSql).toContain("'principal'"); // tier / kind / system_role values
    expect(insertSql).toContain('tier');
    expect(insertSql).toContain('kind');
    expect(insertSql).toContain('system_role');
  });

  it('returns result with alreadyExisted=false when principal is newly created', async () => {
    const client = makeClient();
    client.query.mockResolvedValue({ rows: [] });

    const { pool } = makePool({ existingRows: [], client });

    const result = await ensurePrincipalContact({ displayName: 'Test CEO' }, pool as never, mockLogger);

    expect(result.alreadyExisted).toBe(false);
    expect(result.kgNodeId).toBe('kg-node-123');
  });

  it('returns result with alreadyExisted=true when principal already exists', async () => {
    const existingRow = {
      id: 'contact-abc',
      display_name: 'Existing CEO',
      kg_node_id: 'kg-node-existing',
    };
    const { pool } = makePool({ existingRows: [existingRow] });

    const result = await ensurePrincipalContact({ displayName: 'New Name' }, pool as never, mockLogger);

    expect(result.alreadyExisted).toBe(true);
    expect(result.contactId).toBe('contact-abc');
    // repairPrincipalMetadata should have been called
    expect(ceoBootstrap.repairPrincipalMetadata).toHaveBeenCalledWith('contact-abc', pool, mockLogger);
  });

  it('throws when displayName is empty', async () => {
    const { pool } = makePool();
    await expect(
      ensurePrincipalContact({ displayName: '   ' }, pool as never, mockLogger),
    ).rejects.toThrow('displayName must be a non-empty string');
  });
});
