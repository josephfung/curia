// src/entity-context/bootstrap.test.ts
//
// Unit tests for bootstrapAgentIdentity.
//
// Strategy: mock pool so tests run without Docker/Postgres.
// Key assertion: the INSERT INTO contacts does NOT reference `status`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bootstrapAgentIdentity } from './bootstrap.js';
import type { Logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Logger mock
// ---------------------------------------------------------------------------

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
// Pool factory
// ---------------------------------------------------------------------------

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bootstrapAgentIdentity: INSERT column list', () => {
  it('contacts INSERT does NOT reference status', async () => {
    const pool = {
      query: vi.fn<QueryFn>()
        // INSERT kg_nodes → returns kgNodeId
        .mockResolvedValueOnce({ rows: [{ id: 'kg-node-agent' }] })
        // INSERT contacts → returns contactId
        .mockResolvedValueOnce({ rows: [{ id: 'contact-agent' }] }),
    };

    await bootstrapAgentIdentity('Curia', pool as never, mockLogger);

    const allSql = pool.query.mock.calls.map((c) => (c[0] as string).toLowerCase());

    // Find the contacts INSERT
    const contactsInsert = allSql.find((sql) => sql.includes('insert into contacts'));
    expect(contactsInsert, 'Should have executed INSERT INTO contacts').toBeDefined();

    expect(contactsInsert!, 'contacts INSERT should not reference status').not.toMatch(/\bstatus\b/);
    expect(contactsInsert!, 'contacts INSERT should not reference trust_level').not.toContain('trust_level');
  });

  it('contacts INSERT sets tier=known, kind=agent, system_role=agent', async () => {
    const pool = {
      query: vi.fn<QueryFn>()
        .mockResolvedValueOnce({ rows: [{ id: 'kg-node-agent' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'contact-agent' }] }),
    };

    await bootstrapAgentIdentity('Curia', pool as never, mockLogger);

    const allSql = pool.query.mock.calls.map((c) => (c[0] as string).toLowerCase());
    const contactsInsert = allSql.find((sql) => sql.includes('insert into contacts'));
    expect(contactsInsert).toBeDefined();

    expect(contactsInsert!).toContain('tier');
    expect(contactsInsert!).toContain('kind');
    expect(contactsInsert!).toContain('system_role');
    expect(contactsInsert!).toContain("'agent'");
    expect(contactsInsert!).toContain("'known'");
  });

  it('returns the contactId and kgNodeId from the DB', async () => {
    const pool = {
      query: vi.fn<QueryFn>()
        .mockResolvedValueOnce({ rows: [{ id: 'kg-node-007' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'contact-007' }] }),
    };

    const result = await bootstrapAgentIdentity('Curia', pool as never, mockLogger);

    expect(result.kgNodeId).toBe('kg-node-007');
    expect(result.contactId).toBe('contact-007');
  });
});
